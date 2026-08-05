"""Check whether either Drive source workbook has changed since the last publish.

Compares each source file's Drive `modifiedTime` against the value recorded in
`meta.json` on the `gh-pages` branch (written by build_dashboard.py on each
publish). Sets the `changed` and `modified_time`/`jrf_modified_time` GitHub
Actions outputs so the workflow can skip the download/build/publish steps when
nothing changed. The JRF file is optional -- GDRIVE_JRF_FILE_ID may not be
configured yet, in which case it's just skipped.
"""
import json
import os
import subprocess

from google.oauth2 import service_account
from googleapiclient.discovery import build


def get_drive_modified_time(file_id):
    creds = service_account.Credentials.from_service_account_info(
        json.loads(os.environ["GDRIVE_CREDENTIALS"]),
        scopes=["https://www.googleapis.com/auth/drive.readonly"],
    )
    service = build("drive", "v3", credentials=creds)
    # supportsAllDrives: metadata-only `files.get` calls can 404 on a file
    # living in a Shared Drive without this flag, even though `get_media`
    # (used by download_sheet.py) resolves the same file fine — harmless to
    # pass when the file isn't on a Shared Drive.
    meta = service.files().get(
        fileId=file_id, fields="modifiedTime", supportsAllDrives=True
    ).execute()
    return meta["modifiedTime"]


def get_previous_modified_time(key):
    result = subprocess.run(
        ["git", "show", "origin/gh-pages:meta.json"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout).get(key)
    except json.JSONDecodeError:
        return None


def check_one(file_id, meta_key):
    """Returns (current_modified_time, changed). Fails open (changed=True)
    on any error checking a *configured* file -- a Drive API hiccup should
    trigger a rebuild, not silently skip one."""
    try:
        current = get_drive_modified_time(file_id)
        previous = get_previous_modified_time(meta_key)
        return current, current != previous
    except Exception as e:
        print("WARNING: could not check Drive modifiedTime for " + meta_key + " (" + repr(e) + "); rebuilding to be safe")
        return "", True


def main():
    current, changed = check_one(os.environ["GDRIVE_FILE_ID"], "source_modified")
    print("Main sheet modifiedTime:    " + current)

    jrf_id = os.environ.get("GDRIVE_JRF_FILE_ID")
    if jrf_id:
        jrf_current, jrf_changed = check_one(jrf_id, "jrf_modified")
        print("JRF sheet modifiedTime:     " + jrf_current)
    else:
        jrf_current, jrf_changed = "", False
        print("GDRIVE_JRF_FILE_ID not set — skipping JRF change check")

    rebuild = changed or jrf_changed

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write("changed=" + ("true" if rebuild else "false") + "\n")
        f.write("modified_time=" + current + "\n")
        f.write("jrf_modified_time=" + jrf_current + "\n")

    print("-> " + ("rebuild needed" if rebuild else "no change, skipping rebuild"))


if __name__ == "__main__":
    main()
