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
        out = resolve.poll("../../key-value-stores/x/records/y", "tok")
    finally:
        resolve._get = orig
    assert out == {"status": "RUNNING"}, out
    assert "/../" not in captured["url"], captured["url"]          # no live traversal segments
    assert "actor-runs/..%2F" in captured["url"], captured["url"]  # slashes escaped, stays one segment


def test_poll_cache_key_is_run_derived_not_client():
    # Cache poisoning guard: the cache key + dataset must come from the RUN itself (its defaultDatasetId and
    # its INPUT record), NEVER from client-supplied ?datasetId=/?videoId=. Otherwise a caller could resolve
    # video A but write cache/<B>.json := A's url, defacing B for everyone for the 6-day TTL.
    def fake_get(url):
        if "/actor-runs/" in url:
            return {"data": {"status": "SUCCEEDED", "defaultDatasetId": "REAL_DS",
                             "defaultKeyValueStoreId": "REAL_KV"}}
        if "/datasets/REAL_DS/items" in url:  # AssertionError if poll used any other (client) dataset id
            return [{"status": "succeeded", "output": {"url": "https://legit.example/v.mp4"}}]
        if "/key-value-stores/REAL_KV/records/INPUT" in url:
            return {"startUrls": ["https://www.youtube.com/watch?v=jNQXAC9IVRw"]}
        raise AssertionError("poll fetched an unexpected (client-controlled?) url: " + url)

    puts = []
    orig_get, orig_put = resolve._get, resolve.cache_put
    resolve._get = fake_get
    resolve.cache_put = lambda vid, url: puts.append((vid, url))
    try:
        out = resolve.poll("run123", "tok")
    finally:
        resolve._get, resolve.cache_put = orig_get, orig_put
    assert out == {"status": "SUCCEEDED", "streamUrl": "https://legit.example/v.mp4"}, out
    # key is the id parsed from the RUN's own INPUT, not anything a client could supply
    assert puts == [("jNQXAC9IVRw", "https://legit.example/v.mp4")], puts


if __name__ == "__main__":
    test_video_id()
    test_same_origin()
    test_poll_run_id_no_path_traversal()
    test_poll_cache_key_is_run_derived_not_client()
    print("test_api.py: OK")
