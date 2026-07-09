"""Security checks for the resolve/save gates. Run: python3 tests/test_api.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
import resolve
import save


def test_video_id():
    good = {
        "https://www.youtube.com/watch?v=jNQXAC9IVRw": "jNQXAC9IVRw",
        "https://youtu.be/jNQXAC9IVRw": "jNQXAC9IVRw",
        "https://www.youtube.com/shorts/jNQXAC9IVRw": "jNQXAC9IVRw",
        "https://www.youtube.com/embed/jNQXAC9IVRw": "jNQXAC9IVRw",
        "https://m.youtube.com/watch?v=jNQXAC9IVRw&t=5s": "jNQXAC9IVRw",
    }
    for url, vid in good.items():
        assert resolve._video_id(url) == vid, url
    bad = [
        "https://evil.com/?x=youtu.be",             # substring bypass of the old gate
        "https://youtube.com.evil.com/watch?v=jNQXAC9IVRw",  # look-alike host
        "http://169.254.169.254/?v=jNQXAC9IVRw",    # SSRF target smuggled via ?v=
        "https://www.youtube.com/watch?v=short",    # id wrong length
        "file:///etc/passwd",
        "not a url",
    ]
    for url in bad:
        assert resolve._video_id(url) == "", url


def test_same_origin():
    host = "asciiv.example.com"
    ok = {"Host": host, "Origin": f"https://{host}"}
    assert save.same_origin(ok)
    assert save.same_origin({"Host": host})  # no Origin/Referer -> allowed (non-browser client)
    assert save.same_origin({"Host": host, "Referer": f"https://{host}/index.html"})
    assert not save.same_origin({"Host": host, "Origin": "https://evil.com"})
    assert not save.same_origin({"Host": host, "Origin": f"https://{host}.evil.com"})


def test_poll_run_id_no_path_traversal():
    # runId/datasetId are client-controlled; they must not be able to escape the intended
    # api.apify.com path (which carries our APIFY_TOKEN) via "../.." traversal.
    captured = {}

    def fake_get(url):
        captured["url"] = url
        return {"data": {"status": "RUNNING"}}  # non-SUCCEEDED -> poll returns before the datasets call

    orig = resolve._get
    resolve._get = fake_get
    try:
        out = resolve.poll("../../key-value-stores/x/records/y", "dsid", "tok")
    finally:
        resolve._get = orig
    assert out == {"status": "RUNNING"}, out
    assert "/../" not in captured["url"], captured["url"]          # no live traversal segments
    assert "actor-runs/..%2F" in captured["url"], captured["url"]  # slashes escaped, stays one segment


if __name__ == "__main__":
    test_video_id()
    test_same_origin()
    test_poll_run_id_no_path_traversal()
    print("test_api.py: OK")
