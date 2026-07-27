# Dashboard auto-rebuild

`.github/workflows/update.yml` runs every 5 minutes (the shortest interval
GitHub Actions schedules reliably support). Most runs do nothing: the
workflow checks the source workbook's Drive `modifiedTime` and only
downloads/rebuilds/publishes when that timestamp has moved since the last
publish.

Why polling instead of a Sheet "on edit" trigger: the source file
(`GDRIVE_FILE_ID`) is a real binary `.xlsb` workbook in Drive, not a native
Google Sheet — `download_sheet.py` pulls it with `files().get_media()`, which
only works on uploaded files. Apps Script's bound `onEdit`/`onChange`
triggers only attach to native Sheets documents, so they don't apply here.
Polling `modifiedTime` works regardless of file type and needs no
credentials beyond the existing `GDRIVE_CREDENTIALS` (already scoped to
`drive.readonly`).

How the check works (`scripts/check_modified.py`):
1. Calls Drive's `files.get(fileId, fields="modifiedTime")` — a cheap
   metadata-only call, no download.
2. Reads `meta.json` off the live `gh-pages` branch (written by
   `build_dashboard.py` on every publish) to get the `source_modified` value
   recorded at the last successful build.
3. If they differ, sets the `changed` step output to `true`; the download,
   build, and publish steps are conditioned on that output (or on `force:
   true` when manually run via `workflow_dispatch`).

Practical effect: after you save an edit to the workbook, the site catches
up within about 5 minutes (plus however long your local sync client takes
to push the change to Drive) rather than waiting for the old weekly
Monday-morning schedule.
