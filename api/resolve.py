"""Vercel Python function: GET /api/resolve?url=<youtube-url> -> {"streamUrl", "title"}.

Resolves a YouTube URL to a direct progressive (audio+video) mp4 CDN URL via yt-dlp's
extract_info(download=False) — no download, no re-hosting. The browser points its <video>
element straight at that URL. See docs/superpowers/specs/2026-07-05-vercel-migration-design.md.

Known limitation (documented in the spec): these googlevideo URLs can be IP/session-locked and
may not send CORS headers, which can break cross-origin playback + the canvas getImageData the
renderer needs. That's the accepted trade-off of resolve-vs-download on serverless.
"""
from http.server import BaseHTTPRequestHandler
import json
import urllib.parse

import yt_dlp

YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    # Progressive mp4 = one URL carrying both audio and video, so a plain <video src> can play it
    # (adaptive/DASH would need MSE). Mirrors the old CLI's -f mp4/best[ext=mp4]/best.
    "format": "best[ext=mp4][acodec!=none][vcodec!=none]/best[ext=mp4]/best",
}


def resolve(url):
    """Return {streamUrl, title} for a YouTube URL, or raise on failure."""
    with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
        info = ydl.extract_info(url, download=False)
    stream = info.get("url")  # extract_info already applied the format selector
    if not stream:  # fall back: scan formats for a progressive mp4 (highest first)
        for f in reversed(info.get("formats", [])):
            if (f.get("ext") == "mp4" and f.get("url")
                    and f.get("acodec") not in (None, "none")
                    and f.get("vcodec") not in (None, "none")):
                stream = f["url"]
                break
    if not stream:
        raise ValueError("no playable progressive mp4 format found for this video")
    return {"streamUrl": stream, "title": info.get("title", "")}


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime calls a class named `handler`
    def do_GET(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = (query.get("url") or [""])[0]
        if not url or "youtu" not in url:
            return self._json(400, {"error": "missing or invalid YouTube url"})
        try:
            payload = resolve(url)
        except Exception as e:  # yt-dlp raises many types; surface a trimmed message
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


if __name__ == "__main__":  # smoke test: `python3 api/resolve.py [url]`
    import sys
    test = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    out = resolve(test)
    assert out["streamUrl"].startswith("http"), out
    print("OK:", out["title"], "\n ", out["streamUrl"][:90], "...")
