#!/usr/bin/env python3
"""Backblaze B2 provisioning for the Prag Music Worker. Called by setup.sh.

  python3 scripts/b2_provision.py provision   create (or reuse) the private bucket,
                                              a key limited to it, and the app/admin tokens
  python3 scripts/b2_provision.py set-url URL record the deployed Worker URL
  python3 scripts/b2_provision.py secrets-json print the Worker secrets as JSON (for wrangler secret bulk)

Everything is kept in worker/.secrets.local (chmod 600, gitignored). The B2 account
key used to create the bucket and the limited key comes from B2_MASTER_KEY_ID and
B2_MASTER_APP_KEY, or from worker/.b2.local in the same KEY=VALUE form. That key
is only needed here; the Worker gets the limited key.
"""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent.parent
SECRETS_FILE = WORKER_DIR / ".secrets.local"
MASTER_FILE = WORKER_DIR / ".b2.local"
WORKER_SECRETS = ["APP_TOKEN", "ADMIN_TOKEN", "B2_ENDPOINT", "B2_REGION", "B2_BUCKET", "B2_KEY_ID", "B2_APP_KEY"]
KEY_CAPABILITIES = ["listBuckets", "listFiles", "readFiles", "writeFiles", "deleteFiles"]
HEADER = "# Prag Music Worker secrets. Private and gitignored. Written by worker/scripts/setup.sh."


def die(msg: str) -> None:
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


def read_kv(path: Path) -> dict:
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def write_secrets(values: dict) -> None:
    order = ["PRAG_MUSIC_URL"] + WORKER_SECRETS
    lines = [HEADER] + [f"{k}={values[k]}" for k in order if values.get(k)]
    lines += [f"{k}={v}" for k, v in values.items() if k not in order and v]
    tmp = SECRETS_FILE.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, SECRETS_FILE)


def b2(url: str, auth: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Authorization", auth)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        try:
            detail = json.load(err)
        except Exception:
            detail = {"status": err.code, "code": "http_error", "message": ""}
        raise B2Error(detail.get("code", ""), detail.get("message", ""), err.code) from None
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        die(f"could not reach Backblaze ({err}). Rerun when the network is back; it is safe to rerun.")


class B2Error(Exception):
    def __init__(self, code: str, message: str, status: int):
        super().__init__(f"{status} {code}: {message}")
        self.code = code
        self.status = status


def authorize(key_id: str, app_key: str) -> dict:
    basic = "Basic " + base64.b64encode(f"{key_id}:{app_key}".encode()).decode()
    return b2("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", basic)


def master_credentials() -> tuple[str, str]:
    file_values = read_kv(MASTER_FILE)
    key_id = os.environ.get("B2_MASTER_KEY_ID") or file_values.get("B2_MASTER_KEY_ID", "")
    app_key = os.environ.get("B2_MASTER_APP_KEY") or file_values.get("B2_MASTER_APP_KEY", "")
    if not key_id or not app_key:
        die("no Backblaze account key. Put B2_MASTER_KEY_ID=... and B2_MASTER_APP_KEY=... in worker/.b2.local "
            "(Backblaze web UI > Application Keys > Add a New Application Key, all buckets, read and write).")
    return key_id, app_key


def provision() -> None:
    values = read_kv(SECRETS_FILE)
    rotate = os.environ.get("ROTATE_TOKENS") == "1"
    for name, env_name in (("APP_TOKEN", "PRAG_APP_TOKEN"), ("ADMIN_TOKEN", "PRAG_ADMIN_TOKEN")):
        supplied = os.environ.get(env_name, "").strip()
        if supplied:
            values[name] = supplied
        elif rotate or not values.get(name):
            values[name] = secrets.token_hex(32)
    if values["APP_TOKEN"] == values["ADMIN_TOKEN"]:
        die("APP_TOKEN and ADMIN_TOKEN must differ")

    key_id, app_key = master_credentials()
    try:
        auth = authorize(key_id, app_key)
    except B2Error as err:
        die(f"Backblaze rejected the account key ({err}). Check worker/.b2.local.")
    account = auth["accountId"]
    storage = auth["apiInfo"]["storageApi"]
    api, token, s3_url = storage["apiUrl"], auth["authorizationToken"], storage["s3ApiUrl"]
    region = re.match(r"https://s3\.([a-z0-9-]+)\.backblazeb2\.com", s3_url)
    if not region:
        die(f"unexpected S3 endpoint from Backblaze: {s3_url}")

    def call(op: str, body: dict) -> dict:
        return b2(f"{api}/b2api/v3/{op}", token, body)

    def find_bucket(name: str):
        try:
            found = call("b2_list_buckets", {"accountId": account, "bucketName": name})["buckets"]
        except B2Error as err:
            die(f"could not list buckets ({err})")
        return found[0] if found else None

    def find_existing_music_bucket():
        # If worker/.secrets.local was lost, reuse the one prag-music-* bucket instead of making another.
        try:
            found = call("b2_list_buckets", {"accountId": account})["buckets"]
        except B2Error as err:
            die(f"could not list buckets ({err})")
        ours = [b for b in found if b["bucketName"].startswith("prag-music-")]
        if len(ours) > 1:
            die("more than one prag-music-* bucket exists; put the right one in worker/.secrets.local as B2_BUCKET=...")
        return ours[0] if ours else None

    # Keep only the latest version of each file, so re-uploads do not pile up storage.
    lifecycle = [{"fileNamePrefix": "", "daysFromHidingToDeleting": 1, "daysFromUploadingToHiding": None}]
    bucket = find_bucket(values["B2_BUCKET"]) if values.get("B2_BUCKET") else find_existing_music_bucket()
    if bucket:
        print(f"Bucket {bucket['bucketName']} already exists.")
        if values.get("B2_BUCKET") != bucket["bucketName"]:
            values["B2_BUCKET"] = bucket["bucketName"]
            values.pop("B2_KEY_ID", None)
            values.pop("B2_APP_KEY", None)
    else:
        for _ in range(5):
            name = "prag-music-" + secrets.token_hex(4)
            try:
                bucket = call("b2_create_bucket", {"accountId": account, "bucketName": name,
                                                   "bucketType": "allPrivate", "lifecycleRules": lifecycle})
                print(f"Created private bucket {name}.")
                break
            except B2Error as err:
                if err.code != "duplicate_bucket_name":
                    die(f"could not create the bucket ({err})")
        else:
            die("could not find a free bucket name")
        values["B2_BUCKET"] = bucket["bucketName"]
        values.pop("B2_KEY_ID", None)
        values.pop("B2_APP_KEY", None)
        # Save now, so a rerun after a failed key step reuses this bucket instead of making another.
        write_secrets(values)
    values["B2_ENDPOINT"] = s3_url
    values["B2_REGION"] = region.group(1)

    if values.get("B2_KEY_ID") and values.get("B2_APP_KEY"):
        try:
            saved = authorize(values["B2_KEY_ID"], values["B2_APP_KEY"])
        except B2Error as err:
            if err.status not in (401, 403):
                die(f"could not check the saved bucket-only key ({err}); try again")
            saved = None
            print(f"Saved bucket-only key no longer works ({err}); making a new one.")
        if saved is not None:
            # v3 puts the key's bucket and rights directly under apiInfo.storageApi.
            info = saved.get("apiInfo", {}).get("storageApi", {})
            caps = set(info.get("capabilities") or [])
            if info.get("bucketId") != bucket["bucketId"] or not set(KEY_CAPABILITIES) <= caps:
                print("Saved key is not limited to this bucket with the needed rights; making a new one.")
                saved = None
            else:
                print("Reusing the bucket-only key from worker/.secrets.local.")
        if saved is None:
            values.pop("B2_KEY_ID", None)
            values.pop("B2_APP_KEY", None)
    if not (values.get("B2_KEY_ID") and values.get("B2_APP_KEY")):
        try:
            key = call("b2_create_key", {"accountId": account, "keyName": "prag-music-worker",
                                         "capabilities": KEY_CAPABILITIES, "bucketId": bucket["bucketId"]})
        except B2Error as err:
            die(f"could not create the bucket-only key ({err}). The account key needs the writeKeys capability.")
        values["B2_KEY_ID"] = key["applicationKeyId"]
        values["B2_APP_KEY"] = key["applicationKey"]
        print("Created key prag-music-worker, limited to that bucket.")
    write_secrets(values)
    print("Saved to worker/.secrets.local (chmod 600).")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "provision":
        provision()
    elif cmd == "set-url" and len(sys.argv) == 3:
        values = read_kv(SECRETS_FILE)
        values["PRAG_MUSIC_URL"] = sys.argv[2].rstrip("/")
        write_secrets(values)
    elif cmd == "secrets-json":
        values = read_kv(SECRETS_FILE)
        missing = [k for k in WORKER_SECRETS if not values.get(k)]
        if missing:
            die("worker/.secrets.local is missing " + ", ".join(missing))
        print(json.dumps({k: values[k] for k in WORKER_SECRETS}))
    else:
        die("usage: b2_provision.py provision | set-url URL | secrets-json")


if __name__ == "__main__":
    main()
