"""Vercel Python function: GET /api/resolve?url=<youtube-url> -> {"streamUrl", "title"}.

Resolves via the Apify `epctex/youtube-video-downloader` actor. Apify downloads the video on *their*
infra (not YouTube-bot-blocked the way Vercel's datacenter IP is), stores the mp4 in Apify's
key-value store, and hands back a public, CORS-enabled (`Access-Control-Allow-Origin: *`) URL the
browser can both play and sample via canvas getImageData. No proxy, and Apify auto-expires the file
(7-day retention) so there's nothing to store or clean up.

Why not yt-dlp: from Vercel's IP YouTube bot-blocks the resolver, and even past that the googlevideo
URL is IP-locked to the resolver + sends no CORS headers. The old yt-dlp/cookies path is in git
history. Cost: ~$0.00015/sec of 360p (~3c for a 3-min clip). Needs APIFY_TOKEN env var.
"""
from http.server import BaseHTTPRequestHandler
import json
import os
import urllib.parse
import urllib.request

ACTOR = "epctex~youtube-video-downloader"
RUN_URL = f"https://api.apify.com/v2/acts/{ACTOR}/run-sync-get-dataset-items"


def resolve(url):
    """Return {streamUrl, title} for a YouTube URL via the Apify downloader, or raise on failure."""
    token = os.environ.get("APIFY_TOKEN")
    if not token:
        raise ValueError("APIFY_TOKEN not set")
    payload = json.dumps({
        "startUrls": [url],
        "quality": "360",        # cheapest tier; plenty once downsampled to ASCII cells
        "storageType": "apify",  # Apify-hosted -> CORS-enabled + auto-expiring, no proxy/cleanup
    }).encode()
    # run-sync blocks until the download finishes, then returns the dataset items.
    req = urllib.request.Request(
        f"{RUN_URL}?token={urllib.parse.quote(token)}&timeout=110",
        data=payload, headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        items = json.load(r)
    for it in items:
        if it.get("demo"):  # actor returns [{"demo":true}...] when its paid plan isn't active
            raise ValueError("Apify actor not activated (demo output) — enable paid usage on it")
        out = it.get("output") or {}
        if it.get("status") == "succeeded" and out.get("url"):
            return {"streamUrl": out["url"], "title": it.get("videoId", "")}
    raise ValueError((items and items[0].get("status")) or "download failed")


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime calls a class named `handler`
    def do_GET(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = (query.get("url") or [""])[0]
        if not url or "youtu" not in url:
            return self._json(400, {"error": "missing or invalid YouTube url"})
        try:
            payload = resolve(url)
        except Exception as e:  # surface a trimmed message
            return self._json(502, {"error": str(e)[-300:]})
        return self._json(200, payload)

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
    test = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    out = resolve(test)
    assert out["streamUrl"].startswith("http"), out
    print("OK:", out["title"], "\n ", out["streamUrl"])
