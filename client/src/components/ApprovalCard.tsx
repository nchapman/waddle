/**
 * The approval gate: the one place the user's judgment is required.
 * Warm red-orange, impossible to miss, keyboard-first:
 * ⏎ approve · esc deny. Nothing else in the UI gets this color family.
 */
import { Button } from "@/components/ui/button";
import { useOnceAnswer } from "@/hooks/use-once-answer";

export function ApprovalCard({
  tool,
  input,
  onAnswer,
}: {
  tool: string;
  input: unknown;
  onAnswer: (approved: boolean) => void;
}) {
  const answer = useOnceAnswer(onAnswer);

  return (
    <div
      role="alertdialog"
      aria-label={`${tool} approval`}
      className="rounded-2xl border border-gate-strong/60 bg-gate-strong/10 p-5 shadow-lg shadow-gate-strong/10"
    >
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gate-strong/20 text-base">
          🔓
        </span>
        <div>
          <div className="text-sm font-semibold">waddle wants to run</div>
          <div className="font-mono text-xs text-gate">{tool}</div>
        </div>
      </div>
      <pre className="mb-4 max-h-48 overflow-auto rounded-xl border border-border/60 bg-background/70 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {JSON.stringify(input, null, 2)}
      </pre>
      <div className="flex items-center gap-2">
        <Button onClick={() => answer(true)} className="gap-2">
          approve <kbd className="rounded bg-primary-foreground/15 px-1.5 py-0.5 text-[10px] font-medium">⏎</kbd>
        </Button>
        <Button variant="destructive" onClick={() => answer(false)} className="gap-2">
          deny <kbd className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium">esc</kbd>
        </Button>
      </div>
    </div>
  );
}
