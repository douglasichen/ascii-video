#!/usr/bin/env python3
"""Convert an mp4's frames to ASCII art and bake them + the audio into one self-contained HTML file."""
import argparse, base64, json, subprocess, sys, tempfile, os

RAMP = " .:-=+*#%@"  # dark -> dense


def probe(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-of", "csv=p=0", path,
    ], text=True).strip()
    w, h, fr = out.split(",")
    num, den = fr.split("/")
    return int(w), int(h), float(num) / float(den)


def byte_to_char(b):
    return RAMP[b * (len(RAMP) - 1) // 255]


CHAR_LUT = [byte_to_char(b) for b in range(256)]


def extract_frames(path, cols, rows, fps):
    vf = f"scale={cols}:{rows},format=gray"
    if fps:
        vf = f"fps={fps}," + vf
    proc = subprocess.Popen([
        "ffmpeg", "-v", "error", "-i", path, "-vf", vf,
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], stdout=subprocess.PIPE)
    frame_size = cols * rows
    frames = []
    while True:
        buf = proc.stdout.read(frame_size)
        if len(buf) < frame_size:
            break
        rows_txt = [
            "".join(CHAR_LUT[b] for b in buf[r * cols:(r + 1) * cols])
            for r in range(rows)
        ]
        frames.append("\n".join(rows_txt))
    proc.stdout.close()
    proc.wait()
    return frames


def extract_audio_b64(path):
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        audio_path = tmp.name
    try:
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-i", path, "-vn",
            "-codec:a", "libmp3lame", "-q:a", "4", audio_path,
        ], check=True)
        with open(audio_path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    finally:
        os.unlink(audio_path)


HTML_TEMPLATE = """<!doctype html>
<html><head><meta charset="utf-8"><title>ASCII video</title>
<style>
  body {{ background:#000; color:#fff; display:flex; flex-direction:column; align-items:center; font-family:monospace; }}
  pre {{ font-size:{font_size}px; line-height:1; margin:20px 0; white-space:pre; }}
  button {{ font-size:16px; padding:8px 16px; }}
</style></head>
<body>
<pre id="screen"></pre>
<button id="playBtn">Play</button>
<audio id="audio" src="data:audio/mp3;base64,{audio_b64}"></audio>
<script>
const frames = {frames_json};
const fps = {fps};
const audio = document.getElementById("audio");
const screen = document.getElementById("screen");
const btn = document.getElementById("playBtn");
let lastIndex = -1;

function tick() {{
  const idx = Math.min(frames.length - 1, Math.floor(audio.currentTime * fps));
  if (idx !== lastIndex) {{
    screen.textContent = frames[idx];
    lastIndex = idx;
  }}
  if (!audio.paused && !audio.ended) requestAnimationFrame(tick);
}}

btn.addEventListener("click", () => {{
  audio.play();
  btn.style.display = "none";
  requestAnimationFrame(tick);
}});
audio.addEventListener("ended", () => {{ btn.style.display = "inline"; btn.textContent = "Replay"; lastIndex = -1; }});
</script>
</body></html>
"""


def build_html(frames, fps, audio_b64, cols):
    font_size = max(4, min(10, int(1600 / cols)))
    return HTML_TEMPLATE.format(
        font_size=font_size,
        audio_b64=audio_b64,
        frames_json=json.dumps(frames),
        fps=fps,
    )


def selftest():
    assert byte_to_char(0) == RAMP[0]
    assert byte_to_char(255) == RAMP[-1]
    assert CHAR_LUT[0] == RAMP[0] and CHAR_LUT[255] == RAMP[-1]
    # monotonic: brighter byte never maps to an earlier (less dense) ramp char
    assert all(RAMP.index(CHAR_LUT[b]) <= RAMP.index(CHAR_LUT[b + 1]) for b in range(255))
    # regression: non-positive --cols must fail fast, not hang (extract_frames'
    # `len(buf) < frame_size` guard is 0 < 0 == False → infinite loop). Runs the
    # CLI in a subprocess with a timeout; a hang would raise TimeoutExpired here.
    r = subprocess.run([sys.executable, os.path.abspath(__file__), "--cols", "0", "x.mp4"],
                       capture_output=True, text=True, timeout=15)
    assert r.returncode != 0 and "cols" in r.stderr, (r.returncode, r.stderr)
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", nargs="?", help="input mp4 path")
    ap.add_argument("-o", "--output", help="output html path (default: <input>.html)")
    ap.add_argument("--cols", type=int, default=100, help="ascii columns (default 100)")
    ap.add_argument("--fps", type=float, default=None, help="frame rate override (default: source fps, i.e. every frame)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return
    if not args.input:
        ap.error("input is required unless --selftest")
    # Non-positive cols → frame_size 0/negative: extract_frames' read guard never
    # trips (0 < 0 is False) so it spins forever, or read(-n) raises; plus a
    # div-by-zero in build_html. Reject at the boundary. fps<=0 gives broken output too.
    if args.cols < 1:
        ap.error("--cols must be a positive integer")
    if args.fps is not None and args.fps <= 0:
        ap.error("--fps must be positive")

    out_path = args.output or os.path.splitext(args.input)[0] + ".html"

    width, height, src_fps = probe(args.input)
    fps = args.fps or src_fps
    rows = max(1, round(args.cols * (height / width) * 0.55))

    print(f"extracting frames ({args.cols}x{rows} @ {fps:.2f}fps)...", file=sys.stderr)
    frames = extract_frames(args.input, args.cols, rows, args.fps)
    print(f"{len(frames)} frames extracted", file=sys.stderr)

    print("extracting audio...", file=sys.stderr)
    audio_b64 = extract_audio_b64(args.input)

    html = build_html(frames, fps, audio_b64, args.cols)
    with open(out_path, "w") as f:
        f.write(html)
    print(f"wrote {out_path} ({len(html)/1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
