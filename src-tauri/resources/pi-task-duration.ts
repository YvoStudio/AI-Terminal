import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type TaskDurationEntry = {
  durationMs: number;
  completedAt: number;
};

const ENTRY_TYPE = "ai-terminal-task-duration";
const TICK_MS = 100;

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m ${seconds}s`;
}

/**
 * AI Terminal's Pi integration:
 * - shows a live elapsed timer in Pi's own working row above the editor;
 * - appends the final duration to the transcript without sending it to the LLM.
 */
export default function taskDurationExtension(pi: ExtensionAPI) {
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const renderWorkingTime = (ctx: ExtensionContext) => {
    if (startedAt === null || ctx.mode !== "tui") return;
    const duration = formatDuration(Date.now() - startedAt);
    ctx.ui.setWorkingMessage(`Working... (${duration})`);
  };

  pi.registerEntryRenderer<TaskDurationEntry>(ENTRY_TYPE, (entry, _options, theme) => {
    const duration = formatDuration(entry.data?.durationMs ?? 0);
    return new Text(theme.fg("dim", theme.italic(`⏱ Agent completed in ${duration}`)), 1, 0);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Keep one timer across automatic retries, compaction retries and queued
    // continuations. agent_settled is the definitive end of the whole task.
    if (startedAt !== null) return;
    startedAt = Date.now();
    renderWorkingTime(ctx);
    stopTimer();
    timer = setInterval(() => renderWorkingTime(ctx), TICK_MS);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (startedAt === null) return;
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    startedAt = null;
    stopTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
    pi.appendEntry<TaskDurationEntry>(ENTRY_TYPE, { durationMs, completedAt });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    startedAt = null;
    stopTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });
}
