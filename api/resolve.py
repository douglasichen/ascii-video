"""Vercel Python function: two-step, non-blocking YouTube resolve via the Apify downloader actor,
with an S3-backed cache of the resolved mp4 URL keyed by video id.

  GET /api/resolve?url=<youtube-url>                        -> cache HIT: {"streamUrl","cached":true}
                                                              cache MISS: {"runId","datasetId","videoId"}
  GET /api/resolve?runId=<id>&datasetId=<id>&videoId=<id>   -> {"status", "streamUrl"?}  (poll; writes cache)

Cache: Apify already hosts the mp4 (its key-value store, ~7-day retention). We just cache that URL string
in our own S3 bucket at cache/<videoId>.json = {streamUrl, expiresAt}. Repeat plays of the same video
skip the Apify run entirely (instant, no cost). TTL is 6 days, under Apify's retention, so an entry never
outlives the file it points at; once it does expire it's simply a cache miss and we re-run. Reads are a
plain public GET (objects are public-read); writes use boto3 (best-effort, never fail the resolve).

Why Apify at all: from Vercel's IP YouTube bot-blocks yt-dlp, and even past that the googlevideo URL is
IP-locked + CORS-less. Apify downloads on its infra and serves a public CORS-enabled mp4. Needs
APIFY_TOKEN; cache needs ASCIIV_BUCKET/ASCIIV_REGION/ASCIIV_KEY_ID/ASCIIV_SECRET.
"""
from http.server import BaseHTTPRequestHandler
import json
import os
import re
import time
import urllib.parse
import urllib.request

ACTOR = "epctex~youtube-video-downloader"
API = "https://api.apify.com/v2"
MAX_CHARGE_USD = 0.10   # hard per-run spend cap: Apify aborts if a download would exceed this (~11 min 360p)
CACHE_TTL = 6 * 24 * 3600  # seconds — under Apify's ~7-day KV retention, so a hit never points at a dead file


_ID = r"[A-Za-z0-9_-]{11}"  # YouTube video ids are exactly 11 of these chars


def _video_id(url):
    """Extract an 11-char video id from a genuine YouTube URL, else "" (rejects non-YouTube hosts).

    Gate for the Apify run (which costs money): require a real youtube host + a well-formed id, so a
    caller can't feed an arbitrary URL through ?url=. Accepts watch, youtu.be, shorts/embed/live/v forms.
    """
    p = urllib.parse.urlparse(url if "://" in url else "https://" + url)
    host = p.netloc.lower().split(":")[0]
    if host == "youtu.be":
        m = re.fullmatch(_ID, p.path.strip("/").split("/")[0])
        return m.group(0) if m else ""
    if host != "youtube.com" and not host.endswith((".youtube.com", ".youtube-nocookie.com")) \
            and host != "youtube-nocookie.com":
        return ""
    v = urllib.parse.parse_qs(p.query).get("v")
    if v and re.fullmatch(_ID, v[0]):
        return v[0]
    m = re.search(r"/(?:shorts|embed|live|v)/(" + _ID + r")", p.path)
    return m.group(1) if m else ""


def _cache_url(vid):
    return f"https://{os.environ['ASCIIV_BUCKET']}.s3.{os.environ.get('ASCIIV_REGION', 'us-east-1')}.amazonaws.com/cache/{vid}.json"


def cache_get(vid):
    """Return the cached stream URL for a video id, or None (miss / expired / not configured)."""
    if not vid or not os.environ.get("ASCIIV_BUCKET"):
        return None
    try:
        with urllib.request.urlopen(_cache_url(vid), timeout=8) as r:
            d = json.load(r)
        if d.get("streamUrl") and d.get("expiresAt", 0) > time.time():
            return d["streamUrl"]
    except Exception:
        pass  # missing object -> 403/404 -> miss
    return None


def cache_put(vid, stream_url):
    """Best-effort write of the resolved URL to S3. Never raises — a cache write must not fail a resolve."""
    if not vid or not os.environ.get("ASCIIV_BUCKET"):
        return
    try:
        import boto3
        from botocore.config import Config
        s3 = boto3.client(
            "s3", region_name=os.environ.get("ASCIIV_REGION", "us-east-1"),
            aws_access_key_id=os.environ["ASCIIV_KEY_ID"],
            aws_secret_access_key=os.environ["ASCIIV_SECRET"],
            config=Config(signature_version="s3v4"),
        )
        body = json.dumps({"streamUrl": stream_url, "expiresAt": int(time.time()) + CACHE_TTL}).encode()
        s3.put_object(Bucket=os.environ["ASCIIV_BUCKET"], Key=f"cache/{vid}.json",
                      Body=body, ContentType="application/json")
    except Exception:
        pass


def start(url, token):
    """Cache hit -> {streamUrl, cached}. Miss -> kick off an actor run and return ids to poll."""
    vid = _video_id(url)
    if not vid:
        raise ValueError("not a valid YouTube video URL")
    cached = cache_get(vid)
    if cached:
        return {"streamUrl": cached, "cached": True}
    canonical = f"https://www.youtube.com/watch?v={vid}"  # only a URL we built reaches the paid actor
    payload = json.dumps({
        "startUrls": [canonical],
        "quality": "360",
        "storageType": "apify",
    }).encode()
    req = urllib.request.Request(
        f"{API}/acts/{ACTOR}/runs?token={urllib.parse.quote(token)}&maxTotalChargeUsd={MAX_CHARGE_USD}",
        data=payload, headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.load(r)["data"]
    return {"runId": d["id"], "datasetId": d["defaultDatasetId"], "status": d["status"], "videoId": vid}


def _get(url):
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)


def _run_video_id(run, tok):
    """The video id the run ACTUALLY resolved, read back from the run's own INPUT record (the JSON `start`
    POSTed: {startUrls:[canonical]}). Server-authoritative on purpose — the cache key must never come from a
    client-supplied ?videoId=, or a caller could resolve video A but cache its URL under video B's key
    (poisoning cache/<B>.json for 6 days). Best-effort: "" -> we just don't cache (a miss, never a poison)."""
    try:
        kv = run.get("defaultKeyValueStoreId")
        if not kv:
            return ""
        inp = _get(f"{API}/key-value-stores/{urllib.parse.quote(kv, safe='')}/records/INPUT?token={tok}")
        urls = (inp or {}).get("startUrls") or []
        first = urls[0] if urls else ""
        if isinstance(first, dict):  # Apify may normalize startUrls to request objects [{url:...}]
            first = first.get("url", "")
        return _video_id(first) if isinstance(first, str) else ""
    except Exception:
        return ""


def poll(run_id, token):
    """{status} while running, or {status:'SUCCEEDED', streamUrl} once ready (and caches the URL under a
    video id DERIVED FROM THE RUN, never a client-supplied one — see below)."""
    tok = urllib.parse.quote(token)
    # safe="" escapes "/" too: run_id is client-controlled, and quote's default safe="/" would let "../.."
    # traverse out of /actor-runs into arbitrary api.apify.com paths carrying our token.
    run = _get(f"{API}/actor-runs/{urllib.parse.quote(run_id, safe='')}?token={tok}")["data"]
    status = run["status"]
    if status == "ABORTED":  # almost always the maxTotalChargeUsd cap tripping on a too-long video
        return {"status": "ABORTED", "error": "video too long (hit the cost limit)"}
    if status != "SUCCEEDED":
        return {"status": status}  # READY / RUNNING / FAILED / TIMED-OUT
    # Take the dataset AND the cache-key video id from the RUN ITSELF (defaultDatasetId + INPUT), never from
    # client params. runId is Apify-issued/unforgeable; datasetId and videoId used to be trusted from the
    # query, which let an attacker pair a real runId with a foreign datasetId/videoId to poison the cache.
    dataset_id = run.get("defaultDatasetId") or ""
    if not dataset_id:
        return {"status": "FAILED", "error": "run has no dataset"}
    items = _get(f"{API}/datasets/{urllib.parse.quote(dataset_id, safe='')}/items?token={tok}")
    for it in items:
        if it.get("demo"):
            return {"status": "FAILED", "error": "Apify actor not activated (demo output)"}
        out = it.get("output") or {}
        if it.get("status") == "succeeded" and out.get("url"):
            vid = _run_video_id(run, tok)  # server-authoritative; "" -> skip the cache write (never poison)
            if vid:
                cache_put(vid, out["url"])
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
            if run_id:  # poll mode — datasetId/videoId in the query are ignored (derived from the run instead)
                return self._json(200, poll(run_id, token))
            if url:  # start mode — reject anything that isn't a genuine YouTube video URL
                if not _video_id(url):
                    return self._json(400, {"error": "not a valid YouTube video URL"})
                return self._json(200, start(url, token))
            return self._json(400, {"error": "missing url or runId"})
        except Exception as e:
            # token rides in the Apify request URL; never let it surface in an error echoed to the client
            return self._json(502, {"error": str(e).replace(token, "***")[-300:]})

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":  # smoke test: APIFY_TOKEN=... python3 api/resolve.py [url]
    import sys
    tok = os.environ["APIFY_TOKEN"]
    test = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    print("videoId:", _video_id(test))
    job = start(test, tok)
    print("started:", job)
    if job.get("streamUrl"):
        print("cache hit:", job["streamUrl"])
    else:
        import time as _t
        for _ in range(60):
            _t.sleep(3)
            s = poll(job["runId"], tok)
            print(" ", s.get("status"), s.get("streamUrl", ""))
            if s.get("streamUrl") or s["status"] in ("FAILED", "ABORTED", "TIMED-OUT"):
                break
