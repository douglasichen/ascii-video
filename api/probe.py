"""TEMPORARY diagnostic: POST a googlevideo URL as the body -> reports what Vercel's IP sees when it
fetches a Range from it. Used to test whether YouTube IP-locks playback URLs to the resolving IP.
Restricted to googlevideo.com hosts (not an open proxy). Delete after the test."""
from http.server import BaseHTTPRequestHandler
import json
import urllib.error
import urllib.parse
import urllib.request


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        url = self.rfile.read(n).decode().strip()
        # Validate the actual host (a substring check let e.g. http://169.254.169.254/?x=googlevideo.com
        # through — an SSRF pivot). Only real *.googlevideo.com hosts over http(s) are allowed.
        p = urllib.parse.urlparse(url)
        host = p.netloc.lower().split(":")[0]
        if p.scheme not in ("http", "https") or not (host == "googlevideo.com" or host.endswith(".googlevideo.com")):
            return self._json({"error": "only googlevideo.com urls"})
        try:
            req = urllib.request.Request(url, headers={"Range": "bytes=0-1"})
            r = urllib.request.urlopen(req, timeout=20)
            self._json({
                "status": r.status,  # 206 = range served, i.e. NOT ip-locked from Vercel
                "acao": r.headers.get("Access-Control-Allow-Origin"),  # CORS header for the canvas
                "content_type": r.headers.get("Content-Type"),
                "content_range": r.headers.get("Content-Range"),
            })
        except urllib.error.HTTPError as e:
            self._json({"status": e.code, "reason": str(e.reason)})  # 403 = ip-locked
        except Exception as e:
            self._json({"error": str(e)[:200]})

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
