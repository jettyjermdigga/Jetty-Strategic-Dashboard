import os, json, io
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

def main():
    creds = service_account.Credentials.from_service_account_info(
        json.loads(os.environ["GDRIVE_CREDENTIALS"]),
        scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    service = build("drive", "v3", credentials=creds)
    request = service.files().get_media(fileId=os.environ["GDRIVE_FILE_ID"])
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    os.makedirs("data", exist_ok=True)
    with open("data/budget.xlsb", "wb") as f:
        f.write(buf.getvalue())
    print("Sheet downloaded OK")

if __name__ == "__main__":
    main()
