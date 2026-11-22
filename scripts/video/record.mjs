// Automated demo recording: drives the real app in headless Chrome, feeds the seller's recorded voice in as the
// microphone, records the Gemini agent's spoken replies from the page, captures screen frames and logs a timeline.
//
// Usage: BASE=https://shopbridge-voiceops.onrender.com node scripts/video/record.mjs [--only s03,s04] [--no-reset] [--out dir]
// Needs: google-chrome, video-build/voice/*.wav (from recordings/), video-build/narration/*.wav (from tts.mjs).
// Output: <out>/frames-{seller,buyer}/*.jpg, <out>/timeline.json, <out>/agent-*.webm
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.resolve("package.json"));
const WebSocket = require("ws");

const BASE = (process.env.BASE || "http://127.0.0.1:8795").replace(/\/$/, "");
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const ONLY = (arg("--only") || "").split(",").filter(Boolean);
const RESET = !process.argv.includes("--no-reset");
const OUT = path.resolve(arg("--out") || `video-build/run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const W = 1920, H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const durationOf = (file) => { const b = readFileSync(file); return (b.length - 44) / (b.readUInt32LE(28)); };
const narr = JSON.parse(readFileSync("scripts/video/narration.json", "utf8"));
const narrationSec = (id) => durationOf(`video-build/narration/${id}.wav`);

mkdirSync(OUT, { recursive: true });
const timeline = [];
const audioFiles = new Set();
const log = (type, data = {}) => { const e = { t: now(), type, ...data }; timeline.push(e); console.log(new Date(e.t).toISOString().slice(11, 23), type, JSON.stringify(data)); };

// ---------------------------------------------------------------------------
// Chrome + CDP
// ---------------------------------------------------------------------------
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  `--window-size=${W},${H}`, `--user-data-dir=${OUT}/chrome-profile`, "about:blank",
], { stdio: "ignore" });
process.on("exit", () => chrome.kill());

let version;
for (let i = 0; i < 60 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); } }
const browserWs = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => browserWs.on("open", r));
let seq = 0;
const pending = new Map();
const handlers = new Map(); // sessionId -> fn(method, params)
browserWs.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method && m.sessionId && handlers.has(m.sessionId)) handlers.get(m.sessionId)(m.method, m.params);
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  browserWs.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// Injected before any page script: fake microphone fed from __say(), and a tap on the agent's audio output.
const SHIM = `(() => {
  const AC = window.AudioContext; let vctx = null, vdest = null;
  function ensure() {
    if (vctx) return;
    vctx = new AC({ sampleRate: 48000 }); vdest = vctx.createMediaStreamDestination();
    const k = vctx.createConstantSource(); const g = vctx.createGain(); g.gain.value = 0; k.connect(g); g.connect(vdest); k.start();
  }
  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async () => { ensure(); await vctx.resume(); return vdest.stream; };
  window.__say = async (b64) => {
    ensure(); await vctx.resume();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = await vctx.decodeAudioData(bytes.buffer);
    const s = vctx.createBufferSource(); s.buffer = buf; s.connect(vdest); s.start();
    return { t: Date.now(), dur: buf.duration };
  };
  window.__rec = [];
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    const r = orig.call(this, target, ...rest);
    try {
      const ctx = this.context;
      if (target === ctx.destination && ctx !== vctx) {
        if (!ctx.__tap) {
          ctx.__tap = ctx.createMediaStreamDestination();
          // Stream every chunk to the recorder process at once, so a page reload never loses the agent's audio.
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const mr = new MediaRecorder(ctx.__tap.stream, { mimeType: "audio/webm;codecs=opus" });
          let start = Date.now();
          mr.onstart = () => { start = Date.now(); };
          mr.ondataavailable = async (e) => {
            if (!e.data.size) return;
            const u = new Uint8Array(await e.data.arrayBuffer());
            let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
            window.__sendAudio && window.__sendAudio(JSON.stringify({ id, start, b64: btoa(s) }));
          };
          mr.start(500);
          window.__rec.push({ mr });
        }
        orig.call(this, ctx.__tap);
      }
    } catch (e) { console.warn("tap failed", e); }
    return r;
  };
  window.__flushRec = async () => { for (const r of window.__rec) if (r.mr.state !== "inactive") { r.mr.requestData(); } await new Promise((r) => setTimeout(r, 400)); };
})();`;

async function openPage(name) {
  const { browserContextId } = await cdp("Target.createBrowserContext");
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const dir = path.join(OUT, `frames-${name}`);
  mkdirSync(dir, { recursive: true });
  let frames = 0;
  const page = {
    name, sessionId, browserContextId,
    send: (m, p) => cdp(m, p, sessionId),
    async eval(expr) {
      const r = await cdp("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`${name} eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
  };
  handlers.set(sessionId, (method, params) => {
    if (method === "Runtime.bindingCalled" && params.name === "__sendAudio") {
      const { id, start, b64 } = JSON.parse(params.payload);
      const file = `agent-${name}-${id}.webm`;
      if (!audioFiles.has(file)) { audioFiles.add(file); timeline.push({ t: start, type: "agent_audio", page: name, file }); }
      appendFileSync(path.join(OUT, file), Buffer.from(b64, "base64"));
      return;
    }
    if (method === "Page.screencastFrame") {
      const ts = Math.round(params.metadata.timestamp * 1000);
      writeFileSync(path.join(dir, `${ts}.jpg`), Buffer.from(params.data, "base64"));
      frames++;
      cdp("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
    }
  });
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Runtime.addBinding", { name: "__sendAudio" });
  await page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });
  await page.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  page.frames = () => frames;
  return page;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
const voice = (id) => readFileSync(`video-build/voice/${id}.wav`).toString("base64");
const J = JSON.stringify;

async function goto(page, hash, { reload = true } = {}) {
  // Hash routes don't reload the page; reload so a changed sign-in takes effect.
  await page.eval(`await window.__flushRec?.();`).catch(() => {});
  await page.send("Page.navigate", { url: `${BASE}/${hash}` });
  await sleep(600);
  if (reload) await page.send("Page.reload", { ignoreCache: false });
  await sleep(reload ? 3500 : 1200);
}
async function signIn(page, account) {
  await page.eval(`await fetch("/api/demo",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account:${J(account)}})});`);
}
async function waitFor(page, predicateJs, timeoutMs = 30000, label = "condition") {
  const end = now() + timeoutMs;
  while (now() < end) {
    try { if (await page.eval(`return Boolean(${predicateJs});`)) return true; } catch { /* page navigating */ }
    await sleep(300);
  }
  console.warn(`  ! timed out waiting for ${label}`);
  log("timeout", { label });
  return false;
}
async function click(page, selector, text = null, { required = true } = {}) {
  const ok = await page.eval(`
    const els = [...document.querySelectorAll(${J(selector)})].filter((e) => e.offsetParent !== null || e.getClientRects().length);
    const el = ${text === null ? "els[0]" : `els.find((e) => e.textContent.replace(/\\s+/g," ").trim().includes(${J(text)}))`};
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await new Promise((r) => setTimeout(r, 450));
    el.click(); return true;`);
  if (!ok && required) { console.warn(`  ! could not click ${selector} ${text ?? ""}`); log("miss", { selector, text }); }
  return ok;
}
async function typeInto(page, selector, text) {
  await page.eval(`const el=document.querySelector(${J(selector)}); el.scrollIntoView({block:"center"}); el.focus();`);
  await page.send("Input.insertText", { text });
}
async function say(page, id) {
  const r = JSON.parse(await page.eval(`return JSON.stringify(await window.__say(${J(voice(id))}));`));
  log("say", { page: page.name, id, t0: r.t, dur: r.dur });
  await sleep(r.dur * 1000 + 300);
}
const readbacks = (page) => page.eval(`return document.querySelectorAll('.vo-readback').length;`);
async function waitNewReadback(page, before, timeout = 35000) {
  return waitFor(page, `document.querySelectorAll('.vo-readback').length > ${before}`, timeout, "approval card");
}
async function waitAgentIdle(page, timeout = 30000) {
  // Last transcript line is the agent's and is final, and stays that way for 1.5 s.
  const idle = `(() => { const t=[...document.querySelectorAll('.vo-turn')]; const l=t[t.length-1]; return l && l.classList.contains('is-agent') && !l.classList.contains('is-live'); })()`;
  const end = now() + timeout;
  while (now() < end) {
    if (await waitFor(page, idle, Math.max(500, end - now()), "agent idle")) { await sleep(1500); if (await page.eval(`return ${idle};`)) return true; }
  }
  return false;
}
async function smoothScroll(page, selectorOrNull, pixels, ms) {
  const steps = Math.max(1, Math.round(ms / 50));
  await page.eval(`
    const root = ${selectorOrNull ? `document.querySelector(${J(selectorOrNull)})` : "null"};
    const scroller = [...document.querySelectorAll("*")].find((e) => { const s=getComputedStyle(e); return (s.overflowY==="auto"||s.overflowY==="scroll") && e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 400; }) || document.scrollingElement;
    for (let i = 0; i < ${steps}; i++) { scroller.scrollBy(0, ${pixels / steps}); await new Promise((r) => setTimeout(r, 50)); }`);
}
/** Signed in as the seller with a live voice session and the briefing finished (for retakes). */
async function ensureLive(page) {
  setCamera("seller");
  await signIn(page, "seller");
  await goto(page, "#/voice");
  if (await click(page, "button", "Start talking", { required: false })) {
    await waitFor(page, `document.querySelector('.vo-turn.is-agent')`, 30000, "briefing");
    await waitAgentIdle(page, 40000);
  }
  await sleep(1500);
}

async function voiceTab(page, label) {
  await click(page, '[role="tab"]', label);
  await sleep(1200);
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
let camera = "seller";
const setCamera = (name) => { if (camera !== name) { camera = name; log("camera", { name }); } };
const fast = async (fn) => { log("fast_start"); try { return await fn(); } finally { log("fast_end"); } };
async function hold(id) {
  const s = narr.scenes.find((x) => x.id === id);
  log("narration", { id, title: s.title, dur: narrationSec(id) });
  await sleep(narrationSec(id) * 1000 + 600);
}

const scenes = [];
const scene = (id, run, prep = null) => scenes.push({ id, run, prep });

let seller, buyer;

scene("s01_landing", async () => {
  setCamera("seller");
  await page_signOut(seller);
  await goto(seller, "");
  await hold("s01_landing");
  await click(seller, "a.hall-how", null);
  await sleep(1500);
  for (let i = 0; i < 7; i++) { await smoothScroll(seller, null, 700, 1600); await sleep(900); }
  await sleep(1500);
});

scene("s02_seller", async () => {
  await goto(seller, "");
  await click(seller, ".demo-btn", "Seller");
  await sleep(3500);
  await goto(seller, "#/voice");
  await hold("s02_seller");
});

scene("s03_briefing", async () => {
  await hold("s03_briefing");
  await click(seller, "button", "Start talking");
  await waitFor(seller, `document.querySelector('.vo-turn.is-agent')`, 30000, "briefing");
  await waitAgentIdle(seller, 40000);
  await sleep(1000);
});

scene("s04_batch", async () => {
  await hold("s04_batch");
  const n = await readbacks(seller);
  await say(seller, "02_batch");
  await waitNewReadback(seller, n);
  await waitAgentIdle(seller);
  await say(seller, "03_yes_bhejdo");
  await waitFor(seller, `/Delay update sent/.test(document.body.innerText)`, 30000, "batch sent");
  await waitAgentIdle(seller);
  await sleep(2000);
});

scene("s05_interrupt", async () => {
  await hold("s05_interrupt");
  const n = await readbacks(seller);
  const turnsBefore = await seller.eval(`return document.querySelectorAll('.vo-turn.is-agent').length;`);
  await say(seller, "04_cancel_1050");
  // Wait until the agent is explaining (a new agent line is being spoken), then cut in.
  await waitFor(seller, `document.querySelectorAll('.vo-turn.is-agent').length > ${turnsBefore} && /ship|dispatch|bhej|already|nahi|cancel/i.test([...document.querySelectorAll('.vo-turn.is-agent')].pop().textContent)`, 25000, "agent explaining");
  await sleep(1400);
  await say(seller, "05_interrupt");
  await waitNewReadback(seller, n);
  await waitAgentIdle(seller);
  await click(seller, ".vo-card button, .vo-timeline button, button", "Approve");
  await waitFor(seller, `/Message sent to/.test(document.body.innerText)`, 20000, "message sent");
  await sleep(3500);
});

scene("s06_noise", async () => {
  await hold("s06_noise");
  const n = await readbacks(seller);
  await say(seller, "06_noisy_correction");
  await waitNewReadback(seller, n);
  await waitAgentIdle(seller);
  await say(seller, "07_haan");
  await waitFor(seller, `/is now shipped/.test(document.body.innerText)`, 25000, "shipped");
  await waitAgentIdle(seller);
  await sleep(1500);
});

scene("s07_return", async () => {
  await hold("s07_return");
  const n = await readbacks(seller);
  await say(seller, "08_return_1042");
  await waitNewReadback(seller, n);
  await waitAgentIdle(seller);
  await say(seller, "09_haan_kardo");
  await waitFor(seller, `/Return started/.test(document.body.innerText)`, 25000, "return started");
  await waitAgentIdle(seller);
  // Undo exactly the return (never another card).
  const undone = await seller.eval(`
    const card = [...document.querySelectorAll('.vo-card')].find((c) => /Start return/.test(c.textContent) && /Done/.test(c.textContent));
    const btn = card && [...card.querySelectorAll('button.vo-link')].find((b) => /Undo/.test(b.textContent));
    if (!btn) return false; btn.scrollIntoView({ block: "center", behavior: "smooth" }); await new Promise((r) => setTimeout(r, 450)); btn.click(); return true;`);
  if (undone) await waitFor(seller, `/return request is cancelled/i.test(document.body.innerText)`, 20000, "undo");
  else log("miss", { selector: "return card undo" });
  await sleep(2500);
}, () => ensureLive(seller));

scene("s08_human", async () => {
  await hold("s08_human");
  await say(seller, "10_return_1054");
  await waitFor(seller, `/RETURN_WINDOW|window|7-day|seven/i.test(document.body.innerText)`, 25000, "blocked");
  await waitAgentIdle(seller);
  const n = await readbacks(seller);
  await say(seller, "11_human");
  if (await waitNewReadback(seller, n, 25000)) {
    await waitAgentIdle(seller);
    await click(seller, "button", "Approve");
  }
  await sleep(3000);
});

scene("s09_offer", async () => {
  await hold("s09_offer");
  const n = await readbacks(seller);
  await say(seller, "12_offer_1055");
  await waitNewReadback(seller, n);
  await waitAgentIdle(seller);
  await say(seller, "07_haan");
  await waitFor(seller, `/Offer of INR/.test(document.body.innerText)`, 25000, "offer sent");
  await waitAgentIdle(seller);
  await sleep(1500);
});

scene("s09b_tamil", async () => {
  await hold("s09b_tamil");
  const n = await readbacks(seller);
  await say(seller, "13_tamil");
  await waitNewReadback(seller, n);
  await waitAgentIdle(seller);
  await say(seller, "07_haan");
  await waitFor(seller, `/Message sent to Lakshmi/.test(document.body.innerText)`, 25000, "tamil sent");
  await sleep(2000);
  await click(seller, "button", "End session");
  await sleep(1000);
});

scene("s10_buyer", async () => {
  await signIn(buyer, "buyer");
  await goto(buyer, "#/inbox");
  await click(buyer, "button, a, li", "Cane and hide tote");
  await sleep(4000);
  setCamera("buyer");
  await hold("s10_buyer");
  await smoothScroll(buyer, null, 400, 1500);
  await sleep(2500);
});

scene("s11_replies", async () => {
  await goto(buyer, "#/inbox");
  await click(buyer, "button, a, li", "Block-print kantha throw");
  await sleep(4000);
  setCamera("buyer");
  await hold("s11_replies");
  await typeInto(buyer, ".ix-composer textarea, .ix-composer input[type=text]", "नमस्ते, रिटर्न का पिकअप कब होगा?");
  await sleep(800);
  await buyer.eval(`document.querySelector('.ix-composer').requestSubmit();`);
  await sleep(2500);
  setCamera("seller");
  await goto(seller, "#/inbox");
  await click(seller, "button, a, li", "Block-print kantha throw");
  await fast(() => waitFor(seller, `[...document.querySelectorAll('.ix-quick .ai')].some(e=>/Gemini/.test(e.textContent))`, 90000, "Gemini chips"));
  await sleep(2500);
  await click(seller, ".ix-quick button", null);
  await sleep(1200);
  await seller.eval(`document.querySelector('.ix-composer').requestSubmit();`);
  await sleep(2500);
  setCamera("buyer");
  await sleep(4500);
});

scene("s12_support", async () => {
  setCamera("seller");
  await signIn(seller, "support");
  await goto(seller, "#/queue");
  await sleep(1000);
  await fast(() => waitFor(seller, `document.querySelector('.queue-ai')`, 180000, "queue triage"));
  await hold("s12_support");
  await click(seller, ".queue-button", null);
  await sleep(2500);
  if (!(await click(seller, "button", "Claim and join conversation", { required: false }))) await click(seller, "button", "Open conversation");
  await sleep(4000);
  if (!(await seller.eval(`return Boolean(document.querySelector('.case-brief'));`))) await click(seller, 'button[aria-label="Order details"]', null);
  await fast(() => waitFor(seller, `document.querySelector('.case-brief .triage-summary')`, 180000, "case triage"));
  await sleep(3000);
  await click(seller, "button", "Use this proposal");
  await sleep(2500);
  await click(seller, ".ix-form button.primary", "Propose");
  await sleep(3500);
});

scene("s13_listing", async () => {
  await signIn(seller, "seller");
  await goto(seller, "#/products");
  await click(seller, "main button", "New piece");
  await sleep(1500);
  await hold("s13_listing");
  await click(seller, ".image-grid label", "kantha", { required: false }) || await click(seller, ".image-grid label", null);
  await sleep(800);
  await typeInto(seller, "#pnote", "hand stitched from old cotton saris, two layers");
  await sleep(600);
  await click(seller, "button", "Draft with Gemini");
  await fast(() => waitFor(seller, `document.getElementById('pname')?.value`, 90000, "listing draft"));
  await smoothScroll(seller, null, 500, 1200);
  await sleep(4000);
  await click(seller, "button", "Cancel");
  await sleep(1000);
});

scene("s14_proof", async () => {
  await goto(seller, "#/voice");
  await voiceTab(seller, "Overview");
  await hold("s14_proof");
  for (let i = 0; i < 5; i++) { await smoothScroll(seller, null, 650, 1800); await sleep(1500); }
  await click(seller, "button", "Run check");
  await fast(() => waitFor(seller, `/Gemini key rotation/.test(document.body.innerText)`, 60000, "preflight"));
  await sleep(3500);
});

scene("s15_close", async () => {
  await voiceTab(seller, "How the AI works");
  await sleep(800);
  await seller.eval(`document.querySelector('.ai-outro')?.scrollIntoView({block:"center", behavior:"smooth"});`);
  await hold("s15_close");
  await sleep(1500);
});

async function page_signOut(page) {
  await page.eval(`await fetch("/api/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).catch(()=>{});`).catch(() => {});
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
seller = await openPage("seller");
buyer = await openPage("buyer");
await goto(seller, "");
await goto(buyer, "");

if (RESET) {
  console.log("Resetting demo data…");
  await signIn(seller, "seller");
  const shared = await seller.eval(`const r=await fetch("/api/demo/reset",{method:"POST",headers:{"Content-Type":"application/json","x-shopbridge-intent":"reset-demo"},body:"{}"}); return r.status;`);
  await sleep(4000);
  await signIn(seller, "seller");
  const voiceReset = await seller.eval(`const r=await fetch("/api/voiceops/demo/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}); return r.status + " " + (await r.text()).slice(0,160);`);
  log("reset", { shared, voice: voiceReset });
}

log("start", { base: BASE, width: W, height: H });
for (const s of scenes) {
  if (ONLY.length && !ONLY.some((o) => s.id.startsWith(o))) continue;
  // Setup for a scene recorded on its own (retakes): runs before the scene's clock starts.
  if (s.prep && ONLY.length) { try { await s.prep(); } catch (error) { console.error(`  ! prep ${s.id} failed:`, error.message); } }
  log("scene", { id: s.id, title: narr.scenes.find((x) => x.id === s.id)?.title ?? s.id, camera });
  try { await s.run(); } catch (error) { console.error(`  ! scene ${s.id} failed:`, error.message); log("error", { id: s.id, message: error.message }); }
  log("scene_end", { id: s.id });
}
log("end");

// Flush the last audio chunks from both pages (everything else was streamed during the run).
for (const page of [seller, buyer]) await page.eval(`await window.__flushRec?.();`).catch(() => {});
await sleep(1500);
await seller.send("Page.stopScreencast").catch(() => {});
await buyer.send("Page.stopScreencast").catch(() => {});
writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify({ base: BASE, width: W, height: H, events: timeline.sort((a, b) => a.t - b.t) }, null, 2));
console.log(`\nSaved ${seller.frames()} seller frames, ${buyer.frames()} buyer frames, timeline and audio to ${OUT}`);
browserWs.close();
chrome.kill();
process.exit(0);
