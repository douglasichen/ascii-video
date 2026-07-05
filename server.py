#!/usr/bin/env python3
"""Serve ascii-drop.html and download YouTube links to current.mp4 via yt-dlp."""
import http.server
import json
import os
import subprocess
import urllib.parse

os.chdir(os.path.dirname(os.path.abspath(__file__)))
VIDEO_FILE = "current.mp4"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Local dev tool that's edited constantly — never let the browser cache a stale page/mp4,
        # or a reload silently serves the old build. (Bit us: edits didn't show until a hard reload.)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/download":
            return self.handle_download(urllib.parse.parse_qs(parsed.query))
        if parsed.path == "/":
            self.path = "/ascii-drop.html"
        return super().do_GET()

    def handle_download(self, query):
        url = (query.get("url") or [""])[0]
        if not url:
            return self.respond_json(400, {"error": "missing url"})
        for f in (VIDEO_FILE, VIDEO_FILE + ".part"):
            if os.path.exists(f):
                os.remove(f)
        try:
            subprocess.run(
                # --http-chunk-size is the canonical fix for YouTube "HTTP Error 416":
                # the CDN rejects one big ranged request on DASH formats but accepts chunks.
                ["yt-dlp", "-f", "mp4/best[ext=mp4]/best",
                 "--http-chunk-size", "10M", "--no-part",
                 "--retries", "5", "--fragment-retries", "5",
                 "-o", VIDEO_FILE, url],
                check=True, capture_output=True, text=True,
            )
        except subprocess.CalledProcessError as e:
            return self.respond_json(500, {"error": e.stderr[-2000:]})
        return self.respond_json(200, {"ok": True})

    def respond_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = 8420
    print(f"http://localhost:{port}")
    http.server.ThreadingHTTPServer(("localhost", port), Handler).serve_forever()
