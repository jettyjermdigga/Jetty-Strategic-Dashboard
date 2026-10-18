"""Make sure the dash's R2 bucket exists before wrangler tries to bind it.

Unlike D1 there is no id to substitute -- an R2 binding names the bucket --
but wrangler still refuses to deploy against a bucket that is not there. So
this creates it once and does nothing on every run after.

Needs CLOUDFLARE_API_TOKEN (with Workers R2 Storage:Edit) and
CLOUDFLARE_ACCOUNT_ID.

If provisioning fails -- most likely because the deploy token predates this
and has no R2 permission -- the binding is stripped from the config rather
than left pointing at a bucket that does not exist. The dash then deploys
and simply shows no artwork, which is a better failure than a deploy that
dies and takes the whole portal with it.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

BUCKET = "jetty-dash-music"
CONFIG = os.environ.get("WRANGLER_CONFIG", "wrangler.toml")
API = "https://api.cloudflare.com/client/v4"


def call(path, token, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def strip_binding(why):
    print("::warning::R2 not provisioned (%s); deploying without artwork." % why)
    text = open(CONFIG, encoding="utf-8").read()
    out = re.sub(r"\n\[\[r2_buckets\]\]\nbinding = \"MUSIC\"\nbucket_name = \"[^\"]+\"\n",
                 "\n", text)
    open(CONFIG, "w", encoding="utf-8").write(out)
    sys.exit(0)


def main():
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not account:
        strip_binding("no credentials")

    base = "/accounts/%s/r2/buckets" % account
    try:
        existing = call(base, token).get("result", {})
        names = [b.get("name") for b in (existing.get("buckets") or [])]
    except urllib.error.HTTPError as err:
        strip_binding("list failed: HTTP %s" % err.code)
        return
    except Exception as err:                                  # noqa: BLE001
        strip_binding("list failed: %s" % err)
        return

    if BUCKET in names:
        print("R2 bucket %s already exists." % BUCKET)
        return

    try:
        call(base, token, method="POST", body={"name": BUCKET})
        print("Created R2 bucket %s." % BUCKET)
    except urllib.error.HTTPError as err:
        # 409 means somebody else created it between the list and the create.
        if err.code == 409:
            print("R2 bucket %s already exists." % BUCKET)
            return
        strip_binding("create failed: HTTP %s" % err.code)
    except Exception as err:                                  # noqa: BLE001
        strip_binding("create failed: %s" % err)


if __name__ == "__main__":
    main()
