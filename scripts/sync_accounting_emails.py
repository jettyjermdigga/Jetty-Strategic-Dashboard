"""Sync accounting emails (Shopify, Stripe, CardPointe, GoCardless payouts) into the
"Ledger 💰" Airtable base, and label + archive the source Gmail messages.

Auth: a Google service account with domain-wide delegation impersonates
GMAIL_DELEGATED_USER (jeremy@jettylife.com) to read/modify their inbox. See
docs/accounting-email-sync-setup.md for the one-time Workspace admin steps.

Field mapping is derived from Accounting_Ledger_Email_Extraction_Rules.xlsx.
"""
import base64
import json
import os
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build

GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
TZ = ZoneInfo("America/New_York")
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"

AIRTABLE_API = "https://api.airtable.com/v0"
AIRTABLE_BASE = "appW8jAfERj3iBzqt"  # Ledger 💰

TABLE_IDS = {
    "JTY": "tblVT2056XJNALnOi",  # JTY Ledger
    "JRF": "tblYv7R6XpFQqP3GX",  # JRF Ledger
}

# JTY Ledger: Bank/Type/Vendor/Xero Category/Revenue-Expense are all multipleSelects.
# JRF Ledger: the same concepts are singleSelect fields there.
MULTI_SELECT_TABLES = {"JTY"}

FIELD_IDS = {
    "JTY": dict(
        date="fldKN5JIca6YJdyPX", amount="fldEXHOlbd7SpbjGn", xero="fldmVMjQXcIW1NXBw",
        invoice="fldwRKDLhq2mPOjCm", bank="fldwQGud76C3j2AqB", type="fldkFrJePQKT0pQUP",
        notes="fldTHaIELsXSf6dAg", rev_exp="fldFJpkDAhT4YZ2yW", vendor="fldLbYIFOpcALkFY2",
    ),
    "JRF": dict(
        date="fldLd3Jonw1fWtLay", amount="fldNT7SbPrEq2QtaF", xero="fldWF3pQ0OJOXHt6l",
        invoice="fldgQyWkK8elFNQoG", bank="fldp9NtgwdjVmDgAa", type="fldQTHxp166Nm744t",
        notes="fldbyBk2ziC9aqJOd", rev_exp="fldOdDxVOzDy7ajc3", vendor="fldnFnzqHwMS89DGS",
    ),
}

# ── Routing rules (from Accounting_Ledger_Email_Extraction_Rules.xlsx) ──────

SHOPIFY_STORES = {
    "Jetty": dict(table="JTY", label="Accounting/Shopify (Jetty)",
                  bank="Columbia", xero="DTC - Shopify", type="Shopify", vendor="Shopify"),
    "Jetty Rock Foundation": dict(table="JRF", label="Accounting/Shopify (JRF)",
                  bank="TD Bank - Operating", xero=None, type="Shopify", vendor="Shopify"),
    "Jetty Playa Bowls": dict(table="JTY", label="Accounting/Shopify (Playa Bowls)",
                  bank="Columbia", xero="Screen Printing Revenue", type="Shopify", vendor="Playa Bowls"),
}

STRIPE_ENTITIES = {
    "Jetty Rock Foundation": dict(table="JRF", label="Accounting/Stripe - JRF",
                  bank="TD Bank - Operating", xero=None, type="Stripe", vendor="Stripe (JRF)"),
    "Jetty Brand": dict(table="JTY", label="Accounting/Stripe - Brand",
                  bank="Columbia", xero="Wholesale Revenue", type="Stripe", vendor="STRIPE (BRAND)"),
    "Jetty DTC": dict(table="JTY", label="Accounting/Stripe - DTC",
                  bank="Columbia", xero="DTC - Jettylife.com", type="Stripe", vendor="Stripe (DTC)"),
    "Jetty Ink": dict(table="JTY", label="Accounting/Stripe - INK",
                  bank="Columbia", xero=None, type="Stripe", vendor="STRIPE (INK)"),
}

CARDPOINTE_RULE = dict(table="JRF", label="Accounting/CardPointe",
                  bank="TD Bank - Operating", xero=None, type="CardPointe (Mobile Cause)",
                  vendor="Give Smart (Mobile Cause)")

GOCARDLESS_RULE = dict(table="JTY", label="Accounting/GoCardless",
                  bank="Columbia", xero="Wholesale Revenue", type="ACH", vendor="GoCardless")

REVENUE_EXPENSE = "Revenue"  # every rule in scope today is revenue

# ── Email parsers ────────────────────────────────────────────────────────────

def money(s):
    return float(s.replace(",", ""))

def parse_shopify(subject, body):
    m = re.search(r"\(\$([\d,]+\.\d{2})\s*USD\)", subject)
    if not m:
        return None
    store = body.strip().splitlines()[0].strip()
    ref_m = re.search(r"Payout #(\d+)", body)
    return {"store": store, "amount": money(m.group(1)), "ref": ref_m.group(1) if ref_m else None}

def parse_stripe(subject, body):
    m = re.search(r"Your \$([\d,]+\.\d{2}) payout for (.+?) is on the way", subject)
    if not m:
        return None
    return {"entity": m.group(2).strip(), "amount": money(m.group(1)), "ref": None}

def parse_gocardless(subject, body):
    m = re.search(r"GoCardless has paid you ([\d,]+\.\d{2}) USD", subject)
    if not m:
        return None
    return {"amount": money(m.group(1)), "ref": None}

def parse_cardpointe(subject, body):
    amt_m = re.search(r"Total Amount:\s*\$?([\d,]+\.\d{2})", body)
    if not amt_m:
        return None
    batch_m = re.search(r"Batch ID:\s*(\d+)", body)
    return {"amount": money(amt_m.group(1)), "ref": batch_m.group(1) if batch_m else None}

# ── Gmail helpers ────────────────────────────────────────────────────────────

def gmail_service():
    info = json.loads(os.environ["GMAIL_CREDENTIALS"])
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=GMAIL_SCOPES
    ).with_subject(os.environ["GMAIL_DELEGATED_USER"])
    return build("gmail", "v1", credentials=creds)

def get_header(headers, name):
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""

def get_plaintext_body(payload):
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"] + "===").decode("utf-8", "replace")
    for part in payload.get("parts", []) or []:
        text = get_plaintext_body(part)
        if text:
            return text
    return ""

def search_all(gmail, query, cap=500):
    ids, page_token = [], None
    while True:
        resp = gmail.users().messages().list(
            userId="me", q=query, pageToken=page_token, maxResults=100
        ).execute()
        ids.extend(m["id"] for m in resp.get("messages", []))
        page_token = resp.get("nextPageToken")
        if not page_token or len(ids) >= cap:
            break
    return ids[:cap]

_label_cache = {}

def get_or_create_label(gmail, name):
    if not _label_cache:
        resp = gmail.users().labels().list(userId="me").execute()
        _label_cache.update({l["name"]: l["id"] for l in resp.get("labels", [])})
    if name not in _label_cache:
        created = gmail.users().labels().create(userId="me", body={"name": name}).execute()
        _label_cache[name] = created["id"]
    return _label_cache[name]

def label_and_archive(gmail, msg_id, label_name):
    label_id = get_or_create_label(gmail, label_name)
    gmail.users().messages().modify(
        userId="me", id=msg_id, body={"addLabelIds": [label_id], "removeLabelIds": ["INBOX"]}
    ).execute()

# ── Airtable helpers ─────────────────────────────────────────────────────────

def airtable_headers():
    return {"Authorization": f"Bearer {os.environ['AIRTABLE_API_KEY']}", "Content-Type": "application/json"}

def already_synced(table_id, msg_id):
    url = f"{AIRTABLE_API}/{AIRTABLE_BASE}/{table_id}"
    params = {"filterByFormula": f'FIND("{msg_id}", {{Notes}}) > 0', "maxRecords": 1}
    r = requests.get(url, headers=airtable_headers(), params=params, timeout=30)
    r.raise_for_status()
    return bool(r.json().get("records"))

def create_record(table_id, fields):
    url = f"{AIRTABLE_API}/{AIRTABLE_BASE}/{table_id}"
    r = requests.post(url, headers=airtable_headers(),
                       json={"records": [{"fields": fields}], "typecast": True}, timeout=30)
    r.raise_for_status()
    return r.json()

def wrap(table, value):
    if value is None:
        return None
    return [value] if table in MULTI_SELECT_TABLES else value

# ── Core pipeline ────────────────────────────────────────────────────────────

STATS = {"logged": 0, "skipped": 0, "unparsed": 0, "unrecognized": 0}

def process(gmail, msg_id, parser, lookup_rule):
    msg = gmail.users().messages().get(userId="me", id=msg_id, format="full").execute()
    headers = msg["payload"]["headers"]
    subject = get_header(headers, "Subject")
    body = get_plaintext_body(msg["payload"])

    parsed = parser(subject, body)
    if not parsed:
        print(f"WARN could not parse message {msg_id!r} subject={subject!r}")
        STATS["unparsed"] += 1
        return

    rule = lookup_rule(parsed)
    if rule is None:
        print(f"WARN unrecognized entity for message {msg_id!r} subject={subject!r} parsed={parsed}")
        STATS["unrecognized"] += 1
        return

    table = rule["table"]
    fids = FIELD_IDS[table]
    table_id = TABLE_IDS[table]

    if already_synced(table_id, msg_id):
        print(f"SKIP already synced: {subject!r}")
        STATS["skipped"] += 1
    else:
        internal_ms = int(msg["internalDate"])
        date_str = datetime.fromtimestamp(internal_ms / 1000, tz=timezone.utc).astimezone(TZ).strftime("%Y-%m-%d")

        fields = {
            fids["date"]: date_str,
            fids["amount"]: parsed["amount"],
            fids["bank"]: wrap(table, rule["bank"]),
            fids["type"]: wrap(table, rule["type"]),
            fids["vendor"]: wrap(table, rule["vendor"]),
            fids["rev_exp"]: wrap(table, REVENUE_EXPENSE),
            fids["notes"]: f"Gmail msg: {msg_id}\n{subject}",
        }
        if rule.get("xero"):
            fields[fids["xero"]] = wrap(table, rule["xero"])
        if parsed.get("ref"):
            fields[fids["invoice"]] = int(parsed["ref"]) if table == "JRF" else parsed["ref"]

        if DRY_RUN:
            print(f"[DRY RUN] would log {table} ${parsed['amount']:.2f} — {subject!r} :: {fields}")
        else:
            create_record(table_id, fields)
            print(f"LOGGED {table} ${parsed['amount']:.2f} — {subject!r}")
        STATS["logged"] += 1

    if DRY_RUN:
        print(f"[DRY RUN] would label+archive with {rule['label']!r}: {subject!r}")
    else:
        label_and_archive(gmail, msg_id, rule["label"])

def main():
    gmail = gmail_service()

    for msg_id in search_all(gmail, 'from:mailer@shopify.com subject:"Payout for"'):
        process(gmail, msg_id, parse_shopify, lambda p: SHOPIFY_STORES.get(p["store"]))

    for msg_id in search_all(gmail, 'from:notifications@stripe.com subject:"is on the way"'):
        process(gmail, msg_id, parse_stripe, lambda p: STRIPE_ENTITIES.get(p["entity"]))

    for msg_id in search_all(gmail, 'from:donotreply@cardpointe.com subject:"Batch Summary"'):
        process(gmail, msg_id, parse_cardpointe, lambda p: CARDPOINTE_RULE)

    for msg_id in search_all(gmail, 'from:no-reply@gocardless.com subject:"has paid you"'):
        process(gmail, msg_id, parse_gocardless, lambda p: GOCARDLESS_RULE)

    print(f"\n{'[DRY RUN] ' if DRY_RUN else ''}Done: {STATS}")

if __name__ == "__main__":
    main()
