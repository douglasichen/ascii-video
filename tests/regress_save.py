"""Regression checks for the /api/save CSRF gate. Run: python3 tests/regress_save.py

Focus: same_origin must not FAIL OPEN. The gate's contract is "the request's
declared host must equal ours"; a hand-rolled netloc.split(":")[0] misreads a
crafted authority's userinfo as the host and lets a foreign host through."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
import save

HOST = "asciiv.xyz"


def test_userinfo_does_not_fail_open():
    # Authority "asciiv.xyz:x@evil.com" -> real host is evil.com (asciiv.xyz:x is userinfo).
    # netloc.split(":")[0] wrongly yields "asciiv.xyz" and matches ours -> would ALLOW.
    for hdr in ("Origin", "Referer"):
        src = f"https://{HOST}:x@evil.com" + ("/p" if hdr == "Referer" else "")
        assert not save.same_origin({"Host": HOST, hdr: src}), (hdr, src)


def test_legit_origins_still_pass():
    assert save.same_origin({"Host": HOST, "Origin": f"https://{HOST}"})
    assert save.same_origin({"Host": HOST, "Origin": f"https://{HOST.upper()}"})  # case-fold
    assert save.same_origin({"Host": f"{HOST}:443", "Origin": f"https://{HOST}"})  # port ignored
    assert save.same_origin({"Host": HOST, "Referer": f"https://{HOST}/index.html"})
    assert save.same_origin({"Host": HOST})  # no Origin/Referer -> non-browser client allowed


def test_cross_origin_and_null_denied():
    assert not save.same_origin({"Host": HOST, "Origin": "https://evil.com"})
    assert not save.same_origin({"Host": HOST, "Origin": f"https://{HOST}.evil.com"})
    assert not save.same_origin({"Host": HOST, "Origin": "null"})   # sandboxed-iframe origin
    assert not save.same_origin({"Host": HOST, "Origin": "https://"})  # no host


if __name__ == "__main__":
    test_userinfo_does_not_fail_open()
    test_legit_origins_still_pass()
    test_cross_origin_and_null_denied()
    print("regress_save.py: OK")
