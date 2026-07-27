"""Check whether the Drive source workbook has changed since the last publish.

Compares the source file's Drive `modifiedTime` against the value recorded in
`meta.json` on the `gh-pages` branch (written by build_dashboard.py on each
publish). Sets the `changed` and `modified_time` GitHub Actions outputs so the
workflow can skip the download/build/publish steps when nothing changed.
"""
import json
import os
import subprocess

from google.oauth2 import service_account
from googleapiclient.discovery import build


def get_drive_modified_time():
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
        fileId=os.environ["GDRIVE_FILE_ID"], fields="modifiedTime", supportsAllDrives=True
    ).execute()
    return meta["modifiedTime"]


def get_previous_modified_time():
    result = subprocess.run(
        ["git", "show", "origin/gh-pages:meta.json"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout).get("source_modified")
    except json.JSONDecodeError:
        return None


def main():
    # This check is purely an optimization to skip unnecessary rebuilds. If it
    # can't get a reliable answer for any reason, fail open (rebuild anyway)
    # rather than letting a Drive API hiccup block real dashboard updates —
    # that would be a much worse outcome than one extra unneeded rebuild.
    try:
        current = get_drive_modified_time()
        previous = get_previous_modified_time()
        changed = current != previous
    except Exception as e:
        print("WARNING: could not check Drive modifiedTime (" + repr(e) + "); rebuilding to be safe")
        current, changed = "", True

    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write("changed=" + ("true" if changed else "false") + "\n")
        f.write("modified_time=" + current + "\n")

    print("Drive file modifiedTime:    " + current)
    print("-> " + ("rebuild needed" if changed else "no change, skipping rebuild"))


if __name__ == "__main__":
    main()
