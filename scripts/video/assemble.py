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
import array
import base64
import bisect
import hashlib
import json
import urllib.request
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

# ---------------------------------------------------------------------------
# Gap narration: silences longer than GAP_S are explained with a short spoken line
# ---------------------------------------------------------------------------
GAP_S = 5.0
MAX_SILENCE_S = 4.8   # silences still longer than this after explanations are shortened
KEEP_SILENCE_S = 2.0  # to this many seconds
STATIC_FRAME_S = 1.5  # a frame held longer than this counts as a still screen
GAP_DIR = os.path.abspath("video-build/gap-narration")
os.makedirs(GAP_DIR, exist_ok=True)
ENV = {}
for line in open(".env"):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.rstrip("\n").split("=", 1)
        ENV[k.strip()] = v.strip().strip("'\"")
KEYS = [ENV.get("GEMINI_API_KEY"), ENV.get("GEMINI_API_KEY_BACKUP")] + [ENV.get(f"GEMINI_API_KEY_BACKUP_{i}") for i in range(2, 10)]
KEYS = [k for k in KEYS if k]
VOICE = json.load(open("scripts/video/narration.json")).get("voice", "Kore")
TTS_MODELS = ["gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"]


def tts_line(text):
    """Speak one explanation line with Gemini TTS (plain text only), cached; returns 48 kHz mono int16 samples."""
    key = hashlib.sha1(f"{VOICE}|{text}".encode()).hexdigest()[:16]
    out48 = os.path.join(GAP_DIR, f"{key}-48k.wav")
    if not os.path.exists(out48):
        pcm, rate = None, 24000
        for model in TTS_MODELS:
            for api_key in KEYS:
                body = json.dumps({
                    "contents": [{"parts": [{"text": text}]}],
                    "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}}},
                }).encode()
                req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", data=body, headers={"Content-Type": "application/json", "x-goog-api-key": api_key})
                try:
                    with urllib.request.urlopen(req, timeout=60) as r:
                        j = json.load(r)
                except Exception:
                    continue
                part = next((p for p in j.get("candidates", [{}])[0].get("content", {}).get("parts", []) if "inlineData" in p), None)
                if part:
                    pcm = base64.b64decode(part["inlineData"]["data"])
                    m = part["inlineData"].get("mimeType", "")
                    rate = int(m.split("rate=")[1].split(";")[0]) if "rate=" in m else 24000
                    break
            if pcm:
                break
        if not pcm:
            print(f"    ! TTS failed for: {text[:60]}")
            return None
        raw = os.path.join(GAP_DIR, f"{key}-raw.wav")
        with wave.open(raw, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm)
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-ar", str(RATE), "-ac", "1", out48])
    with wave.open(out48) as w:
        return array.array("h", w.readframes(w.getnframes()))


def silent_gaps(samples, min_s):
    """[(start_s, end_s)] where the audio stays quieter than about -40 dBFS for at least min_s."""
    win = RATE // 10
    gaps, start = [], None
    for i in range(0, len(samples), win):
        chunk = samples[i:i + win]
        rms = (sum(x * x for x in chunk[::8]) / max(1, len(chunk[::8]))) ** 0.5
        t = i / RATE
        if rms < 330:
            start = t if start is None else start
        else:
            if start is not None and t - start >= min_s:
                gaps.append((start, t))
            start = None
    if start is not None and len(samples) / RATE - start >= min_s:
        gaps.append((start, len(samples) / RATE))
    return gaps


def fill_gaps(pcm_bytes, notes, extra=()):
    """Mix an explanation into every silence > GAP_S that it fits: first the recorded note for that moment,
    then the scene's extra lines in order. Long silences can take several lines; nothing talks over the
    seller or the agent."""
    samples = array.array("h", bytes(pcm_bytes))
    used = set()
    placed = 0
    spare = list(extra)
    for _ in range(6):  # repeat: a long silence may still be > GAP_S after one line
        progress = False
        for gs, ge in silent_gaps(samples, GAP_S):
            cands = [n for n in notes if n[1] not in used and n[0] <= gs + 1.5]
            if not cands:
                cands = [n for n in notes if n[1] not in used and gs <= n[0] <= ge]
            text = None
            if cands:
                text = (max(cands, key=lambda n: n[0]) if any(n[0] <= gs + 1.5 for n in cands) else min(cands, key=lambda n: n[0]))[1]
            line = tts_line(text) if text else None
            start = int((gs + 0.5) * RATE)
            if line is None or start + len(line) > int((ge - 0.3) * RATE):
                text, line = None, None
                for cand in spare:
                    l = tts_line(cand)
                    if l is not None and start + len(l) <= int((ge - 0.3) * RATE):
                        text, line = cand, l
                        break
                if line is None:
                    continue
                spare.remove(text)
            for k, v in enumerate(line):
                x = samples[start + k] + v
                samples[start + k] = 32767 if x > 32767 else -32768 if x < -32768 else x
            used.add(text)
            placed += 1
            progress = True
        if not progress:
            break
    return samples.tobytes(), placed


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

    # Trim narration pauses recorded for a longer narration than the current clip (speed 0 = dropped).
    drops = []
    for e in ev:
        if e["type"] == "narration":
            npath = f"video-build/narration/{e['id']}.wav"
            if os.path.exists(npath):
                with wave.open(npath) as w:
                    now_dur = w.getnframes() / w.getframerate()
                keep_until = e["t"] + (now_dur + 0.7) * 1000
                recorded_until = e["t"] + (e.get("dur", now_dur) + 0.6) * 1000
                if recorded_until - keep_until > 300:
                    drops.append((keep_until, recorded_until))
    drops += [(e["from"], e["to"]) for e in ev if e["type"] == "drop"]
    drops.sort()
    for da, db in drops:
        nxt = []
        for a, b, sp in cuts:
            if db <= a or da >= b or sp == 0:
                nxt.append((a, b, sp))
                continue
            if a < da:
                nxt.append((a, da, sp))
            nxt.append((max(a, da), min(b, db), 0))
            if db < b:
                nxt.append((db, b, sp))
        cuts = nxt

    def out_time(t):
        acc = 0.0
        for a, b, sp in cuts:
            if t <= a:
                return acc
            if t <= b:
                return acc + ((t - a) / 1000 / sp if sp else 0)
            acc += (b - a) / 1000 / sp if sp else 0
        return acc

    total = out_time(b0)
    start_cam = start.get("camera", "seller")
    bounds = sorted({t for t, _ in r.cameras if a0 < t < b0})
    entries = []
    for a, b, sp in cuts:
        if sp == 0:
            continue
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
        if sp == 0:
            continue
        pcm += chunk if sp == 1.0 else b"\x00" * (int((e2 - s) / sp) // 2 * 2)
    notes = [(out_time(e["t"]), e["text"]) for e in ev if e["type"] == "explain"]
    extra = NARR.get(sid, {}).get("fill", [])
    filled, placed = fill_gaps(pcm, notes, extra) if (notes or extra) else (bytes(pcm), 0)
    cut = os.path.join(WORK, f"{index:02d}-{sid}-audio.wav")
    with wave.open(cut, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(filled)
    if placed:
        print(f"    {sid}: explained {placed} silent gap(s)")

    # Overlays: scene title for 4 s, "sped up" label, disclosure line.
    title = NARR.get(sid, {}).get("title", sid)
    draws = [
        "drawtext=fontfile=" + FONT + ":text='Live recording · seller voice\\: real · agent\\: Gemini Live, unedited · narration\\: Gemini TTS':fontcolor=white@0.85:fontsize=18:box=1:boxcolor=black@0.45:boxborderw=8:x=w-tw-24:y=h-40",
    ]
    for a, b, sp in cuts:
        if sp not in (0, 1.0):
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
    # Shorten any silence still longer than MAX_SILENCE_S (page loads, long scrolls) to KEEP_SILENCE_S.
    keep_gaps = silent_gaps(array.array("h", filled), MAX_SILENCE_S)
    # Only cut where the screen is ALSO still: a single frame held for a while (page loads, idle waits).
    # Silent stretches with movement (scrolling, clicks, steps appearing) are kept in full.
    static, t_out = [], 0.0
    for _, dur in entries:
        if dur > STATIC_FRAME_S:
            static.append((t_out, t_out + dur))
        t_out += dur
    cuts_out = []
    for gs, ge in keep_gaps:
        for sa, sb in static:
            a_, b_ = max(gs, sa) + 0.6, min(ge, sb) - 0.4
            if b_ - a_ > 0.5:
                cuts_out.append((a_, b_))
    # Dead time at a scene's edges (navigation before the narration, waiting after the last sound): keep 1 s / 1.5 s.
    smp = array.array("h", filled)
    loud = [i / 10 for i in range(0, int(total * 10)) if max((abs(x) for x in smp[int(i / 10 * RATE):int(i / 10 * RATE) + RATE // 10][::16]), default=0) > 1200]
    if loud:
        if loud[0] > 1.2:
            cuts_out.append((0.2, loud[0] - 1.0))
        if total - loud[-1] > 2.0:
            cuts_out.append((loud[-1] + 1.5, total - 0.05))
    cuts_out.sort()
    title_draw = "drawtext=fontfile=" + FONT_BOLD + f":text='{esc(title)}':fontcolor=white:fontsize=40:box=1:boxcolor=0x1d1712@0.82:boxborderw=22:x=56:y=h-160:enable='between(t,0.3,4.3)'"
    if True:  # final pass: trims (if any) and the scene title, drawn on the trimmed clip
        keep, cursor_s = [], 0.0
        for cut_a, cut_b in cuts_out:
            if cut_a > cursor_s:
                keep.append((cursor_s, cut_a))
            cursor_s = max(cursor_s, cut_b)
        keep.append((cursor_s, total))
        keep = [(x, y) for x, y in keep if y - x > 0.05]
        parts = []
        for i, (x, y) in enumerate(keep):
            parts.append(f"[0:v]trim=start={x:.3f}:end={y:.3f},setpts=PTS-STARTPTS[v{i}];[0:a]atrim=start={x:.3f}:end={y:.3f},asetpts=PTS-STARTPTS[a{i}]")
        graph = ";".join(parts) + ";" + "".join(f"[v{i}][a{i}]" for i in range(len(keep))) + f"concat=n={len(keep)}:v=1:a=1[vc][a];[vc]{title_draw}[v]"
        trimmed = clip.replace(".mp4", "-trim.mp4")
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", clip, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-ac", "2", trimmed])
        os.replace(trimmed, clip)
        total = sum(y - x for x, y in keep)
        if cuts_out:
            print(f"    {sid}: trimmed {len(cuts_out)} still/dead stretch(es)")
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
