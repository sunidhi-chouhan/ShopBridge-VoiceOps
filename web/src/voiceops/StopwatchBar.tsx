import { useEffect, useState } from "react";
import { recordVoiceBaseline } from "../api";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { BASELINE_TASKS, taskLabel } from "./baseline";
import { useVoice } from "./VoiceContext";

/** Floating bar shown on every seller screen while a manual task is being timed. */
export function StopwatchBar() {
  const { stopwatch, stopStopwatch, refresh } = useVoice();
  const [now, setNow] = useState(Date.now());
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!stopwatch) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [stopwatch]);
  if (!stopwatch) return null;

  const secs = Math.max(0, Math.floor((now - stopwatch.startedAt) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  async function done() {
    const run = stopStopwatch();
    if (!run) return;
    setSaving(true);
    try {
      await recordVoiceBaseline({ task: run.task, seconds: Math.round(run.seconds * 10) / 10, taps: run.taps, keys: run.keys });
      toast(`Saved: ${taskLabel(run.task)} took ${Math.round(run.seconds)} s, ${run.taps} taps, ${run.keys} keys by hand.`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save the timing.");
    } finally {
      setSaving(false);
    }
  }
  const how = BASELINE_TASKS.find((t) => t.task === stopwatch.task)?.how;
  return (
    <div className="vo-stopwatch" data-stopwatch role="region" aria-label="Manual task timer">
      <div className="vo-stopwatch-head">
        <strong>Timing by hand: {taskLabel(stopwatch.task)}</strong>
        <span className="vo-stopwatch-clock" aria-live="off">{clock}</span>
      </div>
      <p className="vo-hint">{how} {stopwatch.taps} taps, {stopwatch.keys} keys so far. Do not use the voice agent.</p>
      <div className="vo-actions">
        <Button pending={saving} onClick={() => void done()}>Done</Button>
        <Button variant="quiet" onClick={() => { stopStopwatch(); toast("Timing discarded."); }}>Discard</Button>
      </div>
    </div>
  );
}
