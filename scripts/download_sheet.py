import os, json, io
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

def download(service, file_id, dest_path):
    request = service.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with open(dest_path, "wb") as f:
        f.write(buf.getvalue())

def main():
    creds = service_account.Credentials.from_service_account_info(
        json.loads(os.environ["GDRIVE_CREDENTIALS"]),
        scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    service = build("drive", "v3", credentials=creds)

    download(service, os.environ["GDRIVE_FILE_ID"], "data/budget.xlsb")
    print("Sheet downloaded OK")

    # JRF's own budget lives in a separate, simpler workbook. Optional: only
    # attempted if the secret is configured, so the main dashboard build
    # never breaks on a missing/unconfigured JRF source.
    jrf_id = os.environ.get("GDRIVE_JRF_FILE_ID")
    if jrf_id:
        download(service, jrf_id, "data/jrf_budget.xlsx")
        print("JRF sheet downloaded OK")
    else:
        print("GDRIVE_JRF_FILE_ID not set — skipping JRF sheet download")

if __name__ == "__main__":
    main()
