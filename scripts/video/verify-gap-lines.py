#!/usr/bin/env python3
"""Check every cached gap-explanation clip (video-build/gap-narration) against its text with Gemini transcription.
A clip that is missing words or has extra words is deleted, so the next assembly regenerates it.

Usage: python3 -I scripts/video/verify-gap-lines.py   -> exit 0 if all OK, 1 if any clip was deleted
"""
import base64
import hashlib
import json
import os
import re
import sys
import urllib.request

ENV = {}
for line in open(".env"):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.rstrip("\n").split("=", 1)
        ENV[k.strip()] = v.strip().strip("'\"")
KEYS = [ENV.get("GEMINI_API_KEY"), ENV.get("GEMINI_API_KEY_BACKUP")] + [ENV.get(f"GEMINI_API_KEY_BACKUP_{i}") for i in range(2, 10)]
KEYS = [k for k in KEYS if k]
MODELS = ["gemini-3.5-transcribe", "gemini-3-flash-preview", "gemini-flash-lite-latest"]
NARR = json.load(open("scripts/video/narration.json"))
VOICE = NARR.get("voice", "Kore")
texts = [t for s in NARR["scenes"] for t in s.get("fill", [])]
texts += re.findall(r'explain\("((?:[^"\\]|\\.)*)"\)', open("scripts/video/record.mjs").read())
DIR = "video-build/gap-narration"
words = lambda s: re.sub(r"[^a-z0-9\s]", " ", s.lower()).split()


def transcribe(path):
    data = base64.b64encode(open(path, "rb").read()).decode()
    body = json.dumps({"contents": [{"parts": [{"inlineData": {"mimeType": "audio/wav", "data": data}}, {"text": "Transcribe this audio exactly. Output only the words."}]}]}).encode()
    for model in MODELS:
        for key in KEYS:
            req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    j = json.load(r)
                return "".join(p.get("text", "") for p in j["candidates"][0]["content"]["parts"]).strip()
            except Exception:
                continue
    return ""


bad = 0
for text in dict.fromkeys(texts):
    key = hashlib.sha1(f"{VOICE}|{text}".encode()).hexdigest()[:16]
    path = os.path.join(DIR, f"{key}-48k.wav")
    if not os.path.exists(path):
        continue
    heard = transcribe(path)
    if not heard:
        print(f"ERR  could not transcribe: {text[:60]}")
        continue
    want, got = words(text), words(heard)
    recall = sum(1 for w in want if w in set(got)) / max(1, len(want))
    precision = sum(1 for w in got if w in set(want)) / max(1, len(got))
    ok = recall >= 0.85 and precision >= 0.85
    print(f"{'OK ' if ok else 'BAD'} {recall:.2f}/{precision:.2f} {text[:70]}" + ("" if ok else f"  heard: {heard[:90]}"))
    if not ok:
        bad += 1
        os.remove(path)
        raw = path.replace("-48k.wav", "-raw.wav")
        if os.path.exists(raw):
            os.remove(raw)
sys.exit(1 if bad else 0)
