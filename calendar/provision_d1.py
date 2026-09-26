"""Make sure the calendar's D1 database exists, then write its id into wrangler.toml.

wrangler needs a literal database_id in the config, but committing one couples the
repo to a database somebody has to create by hand first. This looks the database
up by name on every deploy, creates it the first time, and substitutes the id
into the placeholder -- so a fresh account deploys with no manual setup and an
existing one keeps pointing at the same store.

Needs CLOUDFLARE_API_TOKEN (with D1:Edit) and CLOUDFLARE_ACCOUNT_ID.

If provisioning fails -- most likely because the deploy token predates the
calendar and has no D1 permission -- the D1 binding is stripped from the config
rather than left pointing at a placeholder. The calendar then deploys and says
plainly that its database is not connected, which is easier to diagnose than a
deploy that dies on a malformed config.
"""

import json
import os
import sys
import urllib.error
import urllib.request

DB_NAME = "jetty_calendar"
PLACEHOLDER = "__D1_DATABASE_ID__"
# Which config to patch. The feed Worker has its own and binds the same
# database, so it needs the same id written into it.
CONFIG = os.environ.get("WRANGLER_CONFIG", "wrangler.toml")
API = "https://api.cloudflare.com/client/v4"


class ProvisionError(Exception):
    pass


def drop_binding(reason):
    """Remove the D1 binding so the rest of the site can still deploy."""
    with open(CONFIG) as fh:
        lines = fh.read().split("\n")
    out, skipping = [], False
    for line in lines:
        if line.strip() == "[[d1_databases]]":
            skipping = True
            continue
        if skipping:
            if line.startswith("[") or (line.strip() and not line.strip()[0].isalpha()):
                skipping = False
            else:
                continue
        out.append(line)
    with open(CONFIG, "w") as fh:
        fh.write("\n".join(out))
    print("::warning::Calendar database not provisioned (%s). Deploying without it -- "
          "the calendar will load and report that its database is not connected."
          % reason)


def call(method, path, token, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        if err.code in (401, 403):
            raise ProvisionError(
                "the API token was rejected (HTTP %d). It needs the 'D1:Edit' permission "
                "on this account -- add it under Cloudflare dashboard -> My Profile -> "
                "API Tokens -> edit the token stored as CLOUDFLARE_API_TOKEN. Response: %s"
                % (err.code, detail)
            )
        raise ProvisionError(
            "Cloudflare API error %d on %s %s: %s" % (err.code, method, path, detail)
        )


def provision(token, account):
    base = "/accounts/" + account + "/d1/database"

    listing = call("GET", base + "?name=" + DB_NAME, token)
    match = next(
        (d for d in (listing.get("result") or []) if d.get("name") == DB_NAME),
        None,
    )

    if match:
        db_id = match.get("uuid") or match.get("id")
        print("Found existing D1 database %s (%s)" % (DB_NAME, db_id))
    else:
        created = call("POST", base, token, {"name": DB_NAME})
        result = created.get("result") or {}
        db_id = result.get("uuid") or result.get("id")
        print("Created D1 database %s (%s)" % (DB_NAME, db_id))

    if not db_id:
        raise ProvisionError("Cloudflare returned no database id for " + DB_NAME + ".")

    with open(CONFIG) as fh:
        config = fh.read()
    if PLACEHOLDER not in config:
        print("No placeholder in %s -- leaving it alone." % CONFIG)
        return
    with open(CONFIG, "w") as fh:
        fh.write(config.replace(PLACEHOLDER, db_id))
    print("Wrote database id into %s" % CONFIG)


def main():
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if not token or not account:
        drop_binding("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not both set")
        return
    try:
        provision(token, account)
    except (ProvisionError, urllib.error.URLError) as err:
        drop_binding(str(err))


if __name__ == "__main__":
    main()
