"""Vercel Python function: POST /api/feedback — store a short user feedback note in a PRIVATE S3 bucket.

Body: JSON {"text": "..."}. Writes feedback/<epoch-ms>-<uuid>.json (text + timestamp + UA/referer) to
ASCIIV_FEEDBACK_BUCKET, server-side, with the same writer key the CDK also grants PutObject on that bucket.
The bucket is NOT public (unlike the clips bucket) — feedback is only ever written here, never read by the
browser. Same-origin guarded; body length capped. boto3 ships in Vercel's Python runtime (Lambda base).

Inert until configured: with no ASCIIV_FEEDBACK_BUCKET it returns 500 and the UI shows "couldn't send".
Needs ASCIIV_FEEDBACK_BUCKET + ASCIIV_REGION / ASCIIV_KEY_ID / ASCIIV_SECRET.
"""
from http.server import BaseHTTPRequestHandler
import json
import os
import time
import urllib.parse
import uuid

MAX_CHARS = 5000  # a feedback note, not an essay — cap the stored body


def same_origin(headers):
    """Lenient CSRF deterrent: if the request declares an Origin/Referer, its host must equal ours."""
    src = headers.get("Origin") or headers.get("Referer") or ""
    if not src:
        return True
    src_host = urllib.parse.urlparse(src).netloc.split(":")[0].lower()
    host = (headers.get("Host") or "").split(":")[0].lower()
    return bool(src_host) and src_host == host


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime calls a class named `handler`
    def do_POST(self):
        if not same_origin(self.headers):
            return self._json(403, {"error": "cross-origin request refused"})
        bucket = os.environ.get("ASCIIV_FEEDBACK_BUCKET")
        if not bucket:
            return self._json(500, {"error": "feedback isn’t set up yet"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            if not isinstance(body, dict):  # valid JSON that isn't an object (e.g. [] / "hi") -> 400, not a crash
                raise ValueError("body must be a JSON object")
        except Exception:
            return self._json(400, {"error": "bad request"})
        text = (body.get("text") or body.get("message") or "").strip()
        if not text:
            return self._json(400, {"error": "type something first"})
        record = {
            "text": text[:MAX_CHARS],
            "at": int(time.time() * 1000),
            "ua": self.headers.get("User-Agent", "")[:300],
            "ref": self.headers.get("Referer", "")[:300],
        }
        try:
            import boto3
            from botocore.config import Config
            s3 = boto3.client(
                "s3", region_name=os.environ.get("ASCIIV_REGION", "us-east-1"),
                aws_access_key_id=os.environ["ASCIIV_KEY_ID"],
                aws_secret_access_key=os.environ["ASCIIV_SECRET"],
                config=Config(signature_version="s3v4"),
            )
            key = f"feedback/{int(time.time() * 1000)}-{uuid.uuid4().hex}.json"
            s3.put_object(Bucket=bucket, Key=key, Body=json.dumps(record).encode(),
                          ContentType="application/json")
        except Exception as e:
            return self._json(502, {"error": str(e)[-200:]})
        return self._json(200, {"ok": True})

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
