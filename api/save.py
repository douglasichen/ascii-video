"""Vercel Python function: POST /api/save -> a presigned S3 POST for uploading one baked .asciiv embed.

Returns {"upload": {"url","fields"}, "key", "getUrl"}. The browser uploads the .asciiv blob directly to
S3 via a multipart POST (fields first, file last). The presigned POST is signed with a
content-length-range condition (<= 25 MB), so no single upload can be huge regardless of request rate —
this is the real per-write cost guard. Object key is <epoch-ms>-<uuid>.asciiv; objects are public-read
(bucket policy) so embeds fetch them directly, and auto-expire after 30 days (bucket lifecycle).

Needs ASCIIV_BUCKET / ASCIIV_REGION / ASCIIV_KEY_ID / ASCIIV_SECRET env vars (set from the CDK stack
outputs). Custom names, not AWS_*, to avoid colliding with the Lambda runtime's injected credentials.

Rate-limiting note: frequency throttling (per-IP / global) is a Vercel Firewall dashboard rule, not code
here — the size cap above + the 30-day lifecycle bound *cost*, which is the actual abuse concern.
"""
from http.server import BaseHTTPRequestHandler
import json
import os
import time
import uuid

import boto3
from botocore.config import Config

MAX_BYTES = 25 * 1024 * 1024  # 25 MB per baked clip


def presign():
    bucket = os.environ["ASCIIV_BUCKET"]
    region = os.environ.get("ASCIIV_REGION", "us-east-1")
    s3 = boto3.client(
        "s3", region_name=region,
        aws_access_key_id=os.environ["ASCIIV_KEY_ID"],
        aws_secret_access_key=os.environ["ASCIIV_SECRET"],
        config=Config(signature_version="s3v4"),
    )
    key = f"{int(time.time() * 1000)}-{uuid.uuid4().hex}.asciiv"
    post = s3.generate_presigned_post(
        Bucket=bucket, Key=key,
        Fields={"Content-Type": "application/octet-stream"},
        Conditions=[["content-length-range", 1, MAX_BYTES],
                    {"Content-Type": "application/octet-stream"}],
        ExpiresIn=300,
    )
    return {"upload": post, "key": key,
            "getUrl": f"https://{bucket}.s3.{region}.amazonaws.com/{key}"}


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime calls a class named `handler`
    def do_POST(self):
        try:
            payload = presign()
        except Exception as e:
            return self._json(500, {"error": str(e)[-300:]})
        return self._json(200, payload)

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
