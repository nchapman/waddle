/**
 * The delegation warning (two-tier autonomy). The one-time gate between
 * tier 0 and tier 1: enabling background tasks hands the enclave the
 * user's full capabilities while it sleeps, on a schedule. Amber — warm,
 * deliberate, distinct from the approval gate's red family. Keyboard:
 * ⏎ enable · esc cancel. Never auto-dismisses.
 */
import { Button } from "@/components/ui/button";
import { useOnceAnswer } from "@/hooks/use-once-answer";

export function BackgroundDialog({
  onAccept,
  onCancel,
}: {
  onAccept: () => void;
  onCancel: () => void;
}) {
  const answer = useOnceAnswer((accept) => (accept ? onAccept() : onCancel()));

  return (
    <div
      role="alertdialog"
      aria-label="enable background tasks"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-2xl border border-amber-500/50 bg-card p-6 shadow-xl shadow-amber-500/10">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/15 text-lg">
            🌙
          </span>
          <div>
            <div className="text-sm font-semibold">Enable background tasks?</div>
            <div className="text-xs text-muted-foreground">one-time choice · change it anytime</div>
          </div>
        </div>
        <p className="mb-3 text-sm leading-relaxed text-foreground/90">
          While your machine sleeps, waddle will wake and <strong>act as you</strong> — your
          secret, your files, your browser, on the schedule you book. This delegates your
          full capabilities to the enclave.
        </p>
        <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
          The wake credential — your secret plus a snapshot of the machine — is held
          only in the concierge's memory until the next task is due. Operators still
          cannot read your data, but a compromised concierge could capture that
          credential while it is armed, snapshot included. Turn this off anytime:
          scheduled work stops and the escrow lapses.
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => answer(false)} className="text-muted-foreground">
            cancel
          </Button>
          <Button
            size="sm"
            onClick={() => answer(true)}
            className="gap-2 border border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
          >
            enable · waddle acts as me
          </Button>
        </div>
      </div>
    </div>
  );
}
