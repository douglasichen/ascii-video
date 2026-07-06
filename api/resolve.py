"""Vercel Python function: two-step, non-blocking YouTube resolve via the Apify downloader actor.

  GET /api/resolve?url=<youtube-url>             -> {"runId","datasetId","status"}   (starts a run)
  GET /api/resolve?runId=<id>&datasetId=<id>     -> {"status", "streamUrl"?}          (polls it)

Why two steps: the Apify actor cold-start + download is 60-100s and highly variable. Blocking the
serverless function that whole time (the old `run-sync` path) sat right on Vercel's timeout cliff, so
longer videos (esp. shorts) intermittently timed out. Starting the run and letting the browser poll
makes every request <1s and removes the cliff.

Apify downloads on its own infra (not YouTube-bot-blocked like Vercel's IP), stores the mp4 in its
key-value store, and serves it CORS-enabled (`Access-Control-Allow-Origin: *`) so the browser plays
and canvas-samples it directly. Auto-expires (7-day retention) -> nothing to store or clean up.
Needs APIFY_TOKEN. Cost ~$0.00015/sec of 360p. The old yt-dlp path is in git history.
"""
from http.server import BaseHTTPRequestHandler
import json
import os
import urllib.parse
import urllib.request

ACTOR = "epctex~youtube-video-downloader"
API = "https://api.apify.com/v2"
MAX_CHARGE_USD = 0.10  # hard per-run spend cap: Apify aborts the run if the download would exceed this
                       # (~11 min of 360p). Server-side backstop on cost, independent of the client's
                       # 5-min duration gate.


def _get(url):
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)


def start(url, token):
    """Kick off an actor run for `url`; returns immediately with ids to poll."""
    payload = json.dumps({
        "startUrls": [url],
        "quality": "360",        # cheapest tier; plenty once downsampled to ASCII cells
        "storageType": "apify",  # Apify-hosted -> CORS-enabled + auto-expiring, no proxy/cleanup
    }).encode()
    req = urllib.request.Request(
        f"{API}/acts/{ACTOR}/runs?token={urllib.parse.quote(token)}&maxTotalChargeUsd={MAX_CHARGE_USD}",
        data=payload, headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.load(r)["data"]
    return {"runId": d["id"], "datasetId": d["defaultDatasetId"], "status": d["status"]}


def poll(run_id, dataset_id, token):
    """Return {status} while running, or {status:'SUCCEEDED', streamUrl} once the mp4 is ready."""
    tok = urllib.parse.quote(token)
    status = _get(f"{API}/actor-runs/{urllib.parse.quote(run_id)}?token={tok}")["data"]["status"]
    if status == "ABORTED":  # almost always the maxTotalChargeUsd cap tripping on a too-long video
        return {"status": "ABORTED", "error": "video too long (hit the cost limit)"}
    if status != "SUCCEEDED":
        return {"status": status}  # READY / RUNNING / FAILED / TIMED-OUT
    items = _get(f"{API}/datasets/{urllib.parse.quote(dataset_id)}/items?token={tok}")
    for it in items:
        if it.get("demo"):  # actor's paid plan not active
            return {"status": "FAILED", "error": "Apify actor not activated (demo output)"}
        out = it.get("output") or {}
        if out.get("url"):
            return {"status": "SUCCEEDED", "streamUrl": out["url"]}
    return {"status": "FAILED", "error": "run succeeded but no video url in output"}


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime calls a class named `handler`
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        token = os.environ.get("APIFY_TOKEN")
        if not token:
            return self._json(500, {"error": "APIFY_TOKEN not set"})
        run_id = (q.get("runId") or [""])[0]
        url = (q.get("url") or [""])[0]
        try:
            if run_id:  # poll mode
                return self._json(200, poll(run_id, (q.get("datasetId") or [""])[0], token))
            if url and "youtu" in url:  # start mode
                return self._json(200, start(url, token))
            return self._json(400, {"error": "missing url or runId"})
        except Exception as e:
            return self._json(502, {"error": str(e)[-300:]})

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":  # smoke test: APIFY_TOKEN=... python3 api/resolve.py [url]
    import sys, time
    tok = os.environ["APIFY_TOKEN"]
    test = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    job = start(test, tok)
    print("started:", job)
    for _ in range(60):
        time.sleep(3)
        s = poll(job["runId"], job["datasetId"], tok)
        print(" ", s.get("status"), s.get("streamUrl", ""))
        if s.get("streamUrl") or s["status"] in ("FAILED", "ABORTED", "TIMED-OUT"):
            break
