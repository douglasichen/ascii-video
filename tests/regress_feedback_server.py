"""Regression checks for api/feedback.py + server.py. Run: python3 tests/regress_feedback_server.py

Bug (fixed): a POST body that is valid JSON but not an object (e.g. `[]`, `"hi"`, `5`) reached
`body.get("text")` unguarded — the try/except only wrapped the read+parse — so it raised
AttributeError, crashing the handler with a 500/reset instead of the graceful 400 the code intends.
"""
import io
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
import feedback


def _run(body_bytes, headers):
    """Drive feedback.handler.do_POST without a socket; return the (status, obj) it emitted."""
    h = feedback.handler.__new__(feedback.handler)  # skip BaseHTTPRequestHandler.__init__ (needs a socket)
    h.headers = headers
    h.rfile = io.BytesIO(body_bytes)
    captured = {}
    h._json = lambda status, obj: captured.update(status=status, obj=obj)  # capture instead of writing the socket
    h.do_POST()
    return captured


def test_non_object_json_is_400_not_crash():
    os.environ["ASCIIV_FEEDBACK_BUCKET"] = "test-bucket"  # get past the "not set up" gate to the body handling
    # No Origin/Referer -> same_origin allows it (non-browser client), so we reach body parsing.
    for raw in (b"[]", b'"hi"', b"5", b"null", b"true"):
        out = _run(raw, {"Content-Length": str(len(raw))})  # crashed with AttributeError before the fix
        assert out.get("status") == 400, (raw, out)


def test_object_body_reaches_storage_not_a_400():
    # A well-formed object must NOT be rejected as bad-request; with no AWS creds it fails at the S3 step (502),
    # proving the non-object 400 above is the type guard, not a blanket rejection.
    os.environ["ASCIIV_FEEDBACK_BUCKET"] = "test-bucket"
    for k in ("ASCIIV_KEY_ID", "ASCIIV_SECRET"):
        os.environ.pop(k, None)
    raw = b'{"text":"hello"}'
    out = _run(raw, {"Content-Length": str(len(raw))})
    assert out.get("status") == 502, out


def test_same_origin_gate():
    host = "asciiv.example.com"
    assert feedback.same_origin({"Host": host, "Origin": f"https://{host}"})
    assert feedback.same_origin({"Host": host})  # no Origin/Referer -> allowed
    assert not feedback.same_origin({"Host": host, "Origin": "https://evil.com"})
    assert not feedback.same_origin({"Host": host, "Origin": f"https://{host}.evil.com"})


if __name__ == "__main__":
    test_non_object_json_is_400_not_crash()
    test_object_body_reaches_storage_not_a_400()
    test_same_origin_gate()
    print("regress_feedback_server.py: OK")
