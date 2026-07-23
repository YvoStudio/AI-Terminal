import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type TaskDurationEntry = {
  durationMs: number;
  completedAt: number;
};

const ENTRY_TYPE = "ai-terminal-task-duration";
const TICK_MS = 100;

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function addUsage(totals: UsageTotals, usage: any): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

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
 * - appends the final duration to the transcript without sending it to the LLM;
 * - replaces Pi's two-line cwd/branch footer with one compact stats line because
 *   AI Terminal already renders cwd and branch in its own bottom bar.
 */
export default function taskDurationExtension(pi: ExtensionAPI) {
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let footerContext: ExtensionContext | null = null;
  let requestFooterRender = () => {};

  const installCompactFooter = (ctx: ExtensionContext) => {
    footerContext = ctx;
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      return {
        invalidate() {},
        render(width: number): string[] {
          const live = footerContext ?? ctx;
          const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          let latestCacheHitRate: number | undefined;

          for (const entry of live.sessionManager.getEntries() as any[]) {
            if (entry.type === "message" && entry.message?.role === "assistant") {
              addUsage(totals, entry.message.usage);
              const usage = entry.message.usage;
              const promptTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
              if (promptTokens > 0) latestCacheHitRate = ((usage?.cacheRead ?? 0) / promptTokens) * 100;
            } else if (entry.type === "message" && entry.message?.role === "toolResult") {
              addUsage(totals, entry.message.usage);
            } else if (entry.type === "branch_summary" || entry.type === "compaction") {
              addUsage(totals, entry.usage);
            }
          }

          const rawParts: string[] = [];
          if (totals.input) rawParts.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) rawParts.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) rawParts.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) rawParts.push(`W${formatTokens(totals.cacheWrite)}`);
          if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate !== undefined) {
            rawParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
          }

          const model = live.model;
          const usingSubscription = !!model
            && (model.provider === "kimi-coding" || live.modelRegistry.isUsingOAuth(model));
          if (totals.cost || usingSubscription) {
            rawParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
          }

          const usage = live.getContextUsage();
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
          const contextPercent = usage?.percent;
          const contextDisplay = contextPercent === null || contextPercent === undefined
            ? `?/${formatTokens(contextWindow)} (auto)`
            : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
          const contextStyled = contextPercent !== null && contextPercent !== undefined && contextPercent > 90
            ? theme.fg("error", contextDisplay)
            : contextPercent !== null && contextPercent !== undefined && contextPercent > 70
              ? theme.fg("warning", contextDisplay)
              : theme.fg("dim", contextDisplay);

          let left = rawParts.length ? `${theme.fg("dim", rawParts.join(" "))} ${contextStyled}` : contextStyled;
          if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
          const leftWidth = visibleWidth(left);

          const modelName = model?.id ?? "no-model";
          const thinking = model?.reasoning
            ? ` • ${pi.getThinkingLevel() === "off" ? "thinking off" : pi.getThinkingLevel()}`
            : "";
          const provider = model ? `(${model.provider}) ` : "";
          const rightRest = ` ${provider}${modelName}${thinking}`;
          let right = theme.fg("success", theme.bold("Pi")) + theme.fg("dim", rightRest);
          const minPadding = 2;
          const availableForRight = width - leftWidth - minPadding;
          if (availableForRight <= 0) {
            right = "";
          } else if (visibleWidth(right) > availableForRight) {
            right = truncateToWidth(right, availableForRight, "");
          }
          const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(right)));
          const lines = [left + padding + right];

          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
            .filter(Boolean);
          if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, "..."));
          return lines;
        },
      };
    });
  };

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

  pi.on("session_start", async (_event, ctx) => {
    installCompactFooter(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    footerContext = ctx;
    requestFooterRender();
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    footerContext = ctx;
    requestFooterRender();
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
    footerContext = null;
    requestFooterRender = () => {};
    stopTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });
}
