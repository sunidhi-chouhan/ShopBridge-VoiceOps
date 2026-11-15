/**
 * Browser side of the VoiceOps Live relay: microphone capture (16 kHz PCM16 via AudioWorklet),
 * gapless playback of the agent's 24 kHz audio, instant barge-in (flush on "interrupted"),
 * and level meters for the waveform.
 */
export type ToolResultPayload = {
  ok: boolean;
  status: "succeeded" | "awaiting_approval" | "blocked" | "failed";
  actionId: string;
  message: string;
  data?: unknown;
  code?: string;
  approval?: { id: string; readback: string; expiresAt: string; duplicate?: boolean };
  latencyMs: number;
};

export type LiveEvent =
  | { type: "ready"; sessionId: string; model: string }
  | { type: "transcript"; role: "user" | "agent"; text: string; final: boolean }
  | { type: "interrupted" }
  | { type: "tool_started"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: ToolResultPayload }
  | { type: "approval_required"; approval: { id: string; readback: string; expiresAt: string }; actionId: string; tool: string }
  | { type: "approval_resolved"; name: string; via?: string; result: ToolResultPayload }
  | { type: "latency"; ms: number }
  | { type: "turn_complete" }
  | { type: "error"; code: string; message: string }
  | { type: "closed"; reason: string };

export class LiveClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private micNode: AudioWorkletNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private micOn = false;
  private bargeTimer: number | null = null;
  private loudTicks = 0;

  constructor(private onEvent: (event: LiveEvent) => void) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  get micActive(): boolean {
    return this.micOn;
  }

  async connect(): Promise<void> {
    this.ctx = new AudioContext();
    await this.ctx.resume();
    this.outAnalyser = this.ctx.createAnalyser();
    this.outAnalyser.fftSize = 256;
    this.outAnalyser.connect(this.ctx.destination);
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/voiceops/live`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Could not open the voice connection. Sign in again and retry."));
    });
    ws.onmessage = (message) => {
      if (message.data instanceof ArrayBuffer) return this.play(message.data);
      const event = JSON.parse(String(message.data)) as LiveEvent;
      if (event.type === "interrupted") this.flush();
      this.onEvent(event);
    };
    ws.onclose = () => {
      this.stopMic();
      this.flush();
      this.onEvent({ type: "closed", reason: "socket_closed" });
    };
  }

  async startMic(): Promise<void> {
    if (!this.ctx || this.micOn) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await this.ctx.audioWorklet.addModule("/voiceops-mic.js");
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 256;
    this.micNode = new AudioWorkletNode(this.ctx, "voiceops-mic");
    this.micNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.open) this.ws!.send(event.data);
    };
    source.connect(this.micAnalyser);
    source.connect(this.micNode);
    this.micOn = true;
    this.startBargeMonitor();
  }

  stopMic(): void {
    if (!this.micOn) return;
    this.micOn = false;
    if (this.bargeTimer !== null) window.clearInterval(this.bargeTimer);
    this.bargeTimer = null;
    this.micNode?.disconnect();
    this.micNode = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.micAnalyser = null;
    if (this.open) this.send({ type: "audio_end" });
  }

  sendText(text: string): void {
    this.send({ type: "text", text });
  }
  approve(approvalId: string): void {
    this.send({ type: "approve", approvalId });
  }
  reject(approvalId: string): void {
    this.send({ type: "reject", approvalId });
  }
  undo(actionId?: string): void {
    this.send({ type: "undo", actionId });
  }

  /** Instantly silence the agent (barge-in). */
  flush(): void {
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  /** 0..1 loudness for the waveform. */
  level(which: "mic" | "agent"): number {
    const analyser = which === "mic" ? this.micAnalyser : this.outAnalyser;
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 64);
  }

  close(): void {
    if (this.open) this.send({ type: "end" });
    this.stopMic();
    this.flush();
    this.ws?.close();
    this.ws = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  /**
   * Client-side barge-in. Gemini generates audio faster than real time, so by the time the seller
   * starts talking the whole reply may already be queued here and the server has nothing left to
   * interrupt. If the mic is clearly louder than the agent's own playback for ~150 ms, cut playback.
   */
  private startBargeMonitor(): void {
    if (this.bargeTimer !== null) return;
    this.bargeTimer = window.setInterval(() => {
      if (this.sources.size === 0) { this.loudTicks = 0; return; }
      const mic = this.level("mic");
      const out = this.level("agent");
      this.loudTicks = mic > 0.3 && mic > out * 1.3 ? this.loudTicks + 1 : 0;
      if (this.loudTicks >= 3) {
        this.loudTicks = 0;
        this.flush();
        this.onEvent({ type: "interrupted" });
      }
    }, 50);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.open) this.ws!.send(JSON.stringify(payload));
  }

  private play(buffer: ArrayBuffer): void {
    if (!this.ctx || !this.outAnalyser) return;
    const pcm = new Int16Array(buffer.slice(0, buffer.byteLength - (buffer.byteLength % 2)));
    if (!pcm.length) return;
    const audio = this.ctx.createBuffer(1, pcm.length, 24000);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = this.ctx.createBufferSource();
    source.buffer = audio;
    source.connect(this.outAnalyser);
    const startAt = Math.max(this.ctx.currentTime + 0.02, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + audio.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }
}
