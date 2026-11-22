#!/usr/bin/env python3
"""Assemble recorded runs into the demo MP4, scene by scene (so retakes can replace single scenes).

Usage:
  python3 -I scripts/video/assemble.py <main-run> [--scene s07_return=<retake-run> ...] [--skip s09b_tamil] [--out file.mp4]

Inputs (from record.mjs): <run>/timeline.json, <run>/frames-{seller,buyer}/<epoch_ms>.jpg, <run>/agent-*.webm,
video-build/voice/<clip>.wav (the seller's recorded voice), video-build/narration/<scene>.wav (Gemini TTS).

Per scene: the active camera's screencast frames timed by capture timestamp; waits on slow Gemini text calls
(fast_start/fast_end) play 4x faster with a label; audio = narration + the seller's real voice + the agent's live
replies, mixed on the original timeline and cut with the same segments (silent while sped up).
"""
import bisect
import json
import os
import subprocess
import sys
import wave

args = sys.argv[1:]
MAIN = os.path.abspath(args[0])
OUT = os.path.abspath(args[args.index("--out") + 1]) if "--out" in args else os.path.abspath("video-build/ShopBridge-VoiceOps-demo.mp4")
OVERRIDES = {}
SKIP = set()
for i, a in enumerate(args):
    if a == "--scene":
        sid, path = args[i + 1].split("=", 1)
        OVERRIDES[sid] = os.path.abspath(path)
    if a == "--skip":
        SKIP.update(args[i + 1].split(","))
SPEED = 4.0
RATE = 48000
FPS = 30
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
WORK = os.path.abspath("video-build/assemble")
os.makedirs(WORK, exist_ok=True)
NARR = {s["id"]: s for s in json.load(open("scripts/video/narration.json"))["scenes"]}


def run(cmd):
    subprocess.run(cmd, check=True)


def esc(text):
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%").replace(",", "\\,")


class Run:
    def __init__(self, path):
        self.path = path
        self.events = json.load(open(os.path.join(path, "timeline.json")))["events"]
        self.frames = {}
        for cam in ("seller", "buyer"):
            d = os.path.join(path, f"frames-{cam}")
            ts = sorted(int(f[:-4]) for f in os.listdir(d) if f.endswith(".jpg")) if os.path.isdir(d) else []
            self.frames[cam] = (d, ts)
        self.cameras = sorted([(e["t"], e["name"]) for e in self.events if e["type"] == "camera"])

    def camera_at(self, t, start_cam):
        cam = start_cam
        for ct, name in self.cameras:
            if ct <= t:
                cam = name
        return cam

    def scene_window(self, sid):
        start = next((e for e in self.events if e["type"] == "scene" and e["id"] == sid), None)
        end = next((e for e in self.events if e["type"] == "scene_end" and e["id"] == sid), None)
        return (start, end) if start and end else (None, None)


runs = {}


def get_run(path):
    if path not in runs:
        runs[path] = Run(path)
    return runs[path]


def build_scene(r, sid, index):
    start, end = r.scene_window(sid)
    if not start:
        print(f"  ! {sid} not in {r.path}")
        return None
    a0, b0 = start["t"], end["t"]
    ev = [e for e in r.events if a0 <= e["t"] <= b0]

    # Segments: normal, or SPEED x inside fast blocks.
    cuts, cursor, fast_at = [], a0, None
    for e in ev:
        if e["type"] == "fast_start" and fast_at is None:
            cuts.append((cursor, e["t"], 1.0))
            fast_at = e["t"]
        elif e["type"] == "fast_end" and fast_at is not None:
            cuts.append((fast_at, e["t"], SPEED))
            cursor = e["t"]
            fast_at = None
    cuts.append((cursor, b0, 1.0) if fast_at is None else (fast_at, b0, SPEED))
    cuts = [c for c in cuts if c[1] - c[0] > 20]

    def out_time(t):
        acc = 0.0
        for a, b, sp in cuts:
            if t <= a:
                return acc
            if t <= b:
                return acc + (t - a) / 1000 / sp
            acc += (b - a) / 1000 / sp
        return acc

    total = out_time(b0)
    start_cam = start.get("camera", "seller")
    bounds = sorted({t for t, _ in r.cameras if a0 < t < b0})
    entries = []
    for a, b, sp in cuts:
        edges = [a] + [x for x in bounds if a < x < b] + [b]
        for i in range(len(edges) - 1):
            pa, pb = edges[i], edges[i + 1]
            cam = r.camera_at(pa + 1, start_cam)
            d, ts = r.frames[cam]
            if not ts:
                continue
            j = bisect.bisect_right(ts, pa)
            path = os.path.join(d, f"{ts[max(0, j - 1)]}.jpg")
            t = pa
            while True:
                nxt = ts[j] if j < len(ts) and ts[j] < pb else pb
                dur = (nxt - t) / 1000 / sp
                if dur > 0:
                    entries.append((path, dur))
                if nxt >= pb:
                    break
                path = os.path.join(d, f"{ts[j]}.jpg")
                t = nxt
                j += 1
    concat = os.path.join(WORK, f"{index:02d}-{sid}.txt")
    with open(concat, "w") as f:
        f.write("ffconcat version 1.0\n")
        for p, dur in entries:
            f.write(f"file '{p}'\nduration {dur:.4f}\n")
        f.write(f"file '{entries[-1][0]}'\n")

    # Audio on this scene's original timeline.
    inputs, filters, labels = [], [], []

    def add(path, at_ms, volume):
        if not os.path.exists(path):
            return
        k = len(inputs) // 2  # inputs holds "-i", path pairs
        inputs.extend(["-i", path])
        delay = int(at_ms - a0)
        if delay >= 0:
            filters.append(f"[{k}:a]aresample={RATE},aformat=channel_layouts=mono,volume={volume},adelay={delay}|{delay}[a{k}]")
        else:  # started before this scene (the agent recording): skip its beginning
            filters.append(f"[{k}:a]aresample={RATE},aformat=channel_layouts=mono,volume={volume},atrim=start={-delay / 1000:.3f},asetpts=PTS-STARTPTS[a{k}]")
        labels.append(f"[a{k}]")

    for e in ev:
        if e["type"] == "narration":
            add(os.path.abspath(f"video-build/narration/{e['id']}.wav"), e["t"], 1.0)
        elif e["type"] == "say":
            add(os.path.abspath(f"video-build/voice/{e['id']}.wav"), e["t0"], 0.95)
    for e in r.events:
        if e["type"] == "agent_audio":
            add(os.path.join(r.path, e["file"]), e["t"], 1.0)
    length = (b0 - a0) / 1000
    mixed = os.path.join(WORK, f"{index:02d}-{sid}-mix.wav")
    if labels:
        filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,apad,atrim=0:{length:.3f},alimiter=limit=0.95[out]")
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filters), "-map", "[out]", "-ar", str(RATE), "-ac", "1", mixed])
    else:
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"anullsrc=r={RATE}:cl=mono", "-t", f"{length:.3f}", mixed])
    with wave.open(mixed) as w:
        raw = w.readframes(w.getnframes())
    pcm = bytearray()
    for a, b, sp in cuts:
        s, e2 = int((a - a0) / 1000 * RATE) * 2, int((b - a0) / 1000 * RATE) * 2
        chunk = raw[s:e2]
        chunk = chunk + b"\x00" * max(0, (e2 - s) - len(chunk))
        pcm += chunk if sp == 1.0 else b"\x00" * (int((e2 - s) / sp) // 2 * 2)
    cut = os.path.join(WORK, f"{index:02d}-{sid}-audio.wav")
    with wave.open(cut, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(pcm))

    # Overlays: scene title for 4 s, "sped up" label, disclosure line.
    title = NARR.get(sid, {}).get("title", sid)
    draws = [
        "drawtext=fontfile=" + FONT_BOLD + f":text='{esc(title)}':fontcolor=white:fontsize=40:box=1:boxcolor=0x1d1712@0.82:boxborderw=22:x=56:y=h-160:enable='between(t,0.3,4.3)'",
        "drawtext=fontfile=" + FONT + ":text='Live recording · seller voice\\: real · agent\\: Gemini Live, unedited · narration\\: Gemini TTS':fontcolor=white@0.85:fontsize=18:box=1:boxcolor=black@0.45:boxborderw=8:x=w-tw-24:y=h-40",
    ]
    for a, b, sp in cuts:
        if sp != 1.0:
            draws.append(
                "drawtext=fontfile=" + FONT + f":text='Gemini text call · sped up {int(sp)}x':fontcolor=white:fontsize=26:box=1:boxcolor=0x4b45a8@0.85:boxborderw=14:x=w-tw-56:y=48:enable='between(t,{out_time(a):.2f},{out_time(b):.2f})'"
            )
    vf = ",".join([f"fps={FPS}", "scale=1920:1080:force_original_aspect_ratio=decrease", "pad=1920:1080:(ow-iw)/2:(oh-ih)/2", *draws, "format=yuv420p"])
    clip = os.path.join(WORK, f"{index:02d}-{sid}.mp4")
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat, "-i", cut,
        "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-ac", "2", "-t", f"{total:.3f}", clip,
    ])
    print(f"  {sid}: {total:.1f}s from {os.path.basename(r.path)}")
    return clip


main = get_run(MAIN)
order = [e["id"] for e in main.events if e["type"] == "scene"]
for sid in OVERRIDES:
    if sid not in order:
        order.append(sid)
order.sort(key=lambda s: list(NARR).index(s) if s in NARR else 99)
clips = []
for i, sid in enumerate(order):
    if sid in SKIP:
        continue
    c = build_scene(get_run(OVERRIDES.get(sid, MAIN)), sid, i)
    if c:
        clips.append(c)

lst = os.path.join(WORK, "clips.txt")
with open(lst, "w") as f:
    for c in clips:
        f.write(f"file '{c}'\n")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", OUT])
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT], capture_output=True, text=True).stdout)
print(f"wrote {OUT} ({dur / 60:.1f} min, {len(clips)} scenes)")
