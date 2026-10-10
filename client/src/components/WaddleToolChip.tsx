/**
 * Per-tool chip for the thread: icon + label + args while running,
 * collapsed result when done. The agent's hands, made visible.
 */
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

const TOOL_META: Record<string, { icon: string; label: string }> = {
  browser_open: { icon: "🌐", label: "opens a page" },
  browser_snapshot: { icon: "🌐", label: "reads the page" },
  browser_click: { icon: "🖱️", label: "clicks" },
  browser_type: { icon: "⌨️", label: "types" },
  bash: { icon: "💻", label: "runs a command" },
  read: { icon: "📄", label: "reads" },
  write: { icon: "✍️", label: "writes" },
  edit: { icon: "✍️", label: "edits" },
};

function resultSummary(result: unknown): string {
  const raw = typeof result === "string" ? result : JSON.stringify(result ?? "");
  try {
    const parsed = JSON.parse(raw) as { content?: Array<{ text?: string }> };
    const text = parsed.content?.[0]?.text;
    if (text) return text.split("\n").slice(0, 3).join(" · ").slice(0, 160);
  } catch {
    /* not our envelope */
  }
  return raw.slice(0, 160);
}

export const WaddleToolChip: ToolCallMessagePartComponent = ({ toolName, argsText, result, status }) => {
  const meta = TOOL_META[toolName] ?? { icon: "⚙️", label: toolName };
  const running = status.type === "running" || (status.type === "incomplete" && !result);
  const failed = status.type === "incomplete" && status.reason === "error";
  let argHint = "";
  try {
    const args = JSON.parse(argsText || "{}") as Record<string, unknown>;
    argHint =
      (typeof args.url === "string" && args.url) ||
      (typeof args.index === "number" && `element ${args.index}`) ||
      (typeof args.command === "string" && args.command) ||
      (typeof args.path === "string" && args.path) ||
      "";
  } catch {
    argHint = "";
  }

  return (
    <div
      className={cn(
        "flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2 text-xs",
        running
          ? "border-duck/40 bg-duck-soft text-foreground/85"
          : failed
            ? "border-gate-strong/50 bg-gate-strong/10 text-foreground/85"
            : "border-border/60 bg-secondary/40 text-muted-foreground",
      )}
      data-slot="waddle-tool-chip"
    >
      <span className={cn("text-sm", running && "animate-spin [animation-duration:2.5s]")}>{meta.icon}</span>
      <span className="font-mono font-medium text-foreground/90">{toolName}</span>
      {argHint && <span className="max-w-[280px] truncate text-muted-foreground">{argHint}</span>}
      {running && <span className="text-duck">running…</span>}
      {!running && !failed && result !== undefined && (
        <span className="min-w-0 flex-1 truncate" title={resultSummary(result)}>
          <span className="text-live">✓</span> {resultSummary(result)}
        </span>
      )}
      {failed && <span className="text-gate-strong">failed</span>}
    </div>
  );
};
