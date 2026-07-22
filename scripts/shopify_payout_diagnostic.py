"""One-off diagnostic: confirm SHOPIFY_ADMIN_API_TOKEN works and inspect the real
shape of Shopify's Payments payout/transaction API response, specifically looking
for whatever field distinguishes "online" vs "stripe_terminal" (Card Source in the
CSV export) so sync_accounting_emails.py can split Jetty payouts into Online vs
Flagship revenue. Not wired into the regular sync — run manually via
workflow_dispatch's diagnose_shopify input.
"""
import json
import os

import requests

STORE = "jettylife.myshopify.com"
API_VERSION = "2024-01"
PAYOUT_ID = "107871666247"  # the $8,311.20 Jul 22, 2026 payout used to validate the CSV format


def get(path, params=None):
    url = f"https://{STORE}/admin/api/{API_VERSION}/{path}"
    r = requests.get(
        url,
        headers={"X-Shopify-Access-Token": os.environ["SHOPIFY_ADMIN_API_TOKEN"], "Accept": "application/json"},
        params=params,
        timeout=30,
    )
    print(f"\n=== GET {path} params={params} -> {r.status_code} ===")
    try:
        body = r.json()
        print(json.dumps(body, indent=2)[:6000])
    except ValueError:
        print(r.text[:2000])
    return r


def main():
    get(f"shopify_payments/payouts/{PAYOUT_ID}.json")
    get("shopify_payments/balance_transactions.json", params={"payout_id": PAYOUT_ID, "limit": 10})


if __name__ == "__main__":
    main()
