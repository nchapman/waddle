/**
 * Ceremony screens: the trust story rendered as calm theater.
 * Shared frame: duck mark, a centered card, quiet copy.
 */
import { DuckMark } from "./DuckMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function CeremonyFrame({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div
        className={cn(
          "w-full rounded-2xl border border-border/70 bg-card p-8 shadow-2xl shadow-black/40",
          wide ? "max-w-xl" : "max-w-md",
        )}
      >
        <div className="mb-6 flex items-center gap-3">
          <DuckMark size={34} className="text-duck" />
          <div>
            <div className="text-lg font-semibold tracking-tight">waddle</div>
            <div className="text-xs text-muted-foreground">your agent, in a sealed enclave</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function VerifyingScreen() {
  const steps = ["measuring the enclave", "verifying the signature", "checking the release"];
  return (
    <CeremonyFrame>
      <div className="space-y-4">
        <div className="text-sm font-medium">Attesting the enclave…</div>
        <div className="space-y-2.5">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-3 text-sm text-muted-foreground">
              <span
                className="relative h-4 w-4 shrink-0 rounded-full border-2 border-duck/40"
                style={{ animationDelay: `${i * 0.45}s` }}
              >
                <span className="waddle-scan absolute inset-0 overflow-hidden rounded-full" />
              </span>
              {s}
            </div>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The client cryptographically verifies what it's talking to before anything leaves this
          device. Nothing is sent over an unattested channel.
        </p>
      </div>
    </CeremonyFrame>
  );
}

export function AttestedScreen({
  releaseTag,
  firstPin,
  locked,
  onUnlock,
  onResume,
}: {
  releaseTag: string;
  firstPin: boolean;
  locked: boolean;
  onUnlock: () => void;
  onResume: () => void;
}) {
  return (
    <CeremonyFrame>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-live" />
          <span className="text-sm font-medium">Attested</span>
          <span className="text-xs text-muted-foreground">
            {releaseTag} {firstPin ? "· first connect (TOFU)" : "· pinned"}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {locked
            ? "The enclave is locked — it holds no key to your data. Unlocking generates a secret on this device, delivers it through the attested channel, and derives every server-side key from it."
            : "The enclave is already unlocked — resume your session."}
        </p>
        <Button onClick={locked ? onUnlock : onResume} className="w-full">
          {locked ? "unlock" : "resume session"}
        </Button>
      </div>
    </CeremonyFrame>
  );
}

export function BlockedScreen({
  pinned,
  current,
  releaseTag,
  releaseDigest,
  onApprove,
}: {
  pinned: string;
  current: string;
  releaseTag: string;
  releaseDigest: string;
  onApprove: () => void;
}) {
  return (
    <CeremonyFrame wide>
      <div className="space-y-5">
        <div className="rounded-xl border border-gate-strong/50 bg-gate-strong/10 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-gate-strong">
            ⚠ code fingerprint changed
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The enclave's measurement no longer matches the one pinned on this device. A new
            release is expected to change it — verify the release really is yours before
            trusting the new measurement.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 font-mono text-xs">
          <div className="rounded-xl border border-border/70 bg-muted/40 p-3">
            <div className="mb-1.5 font-sans text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              pinned
            </div>
            <div className="break-all">{pinned}</div>
          </div>
          <div className="rounded-xl border border-gate-strong/40 bg-gate-strong/5 p-3">
            <div className="mb-1.5 font-sans text-[11px] font-medium uppercase tracking-wide text-gate-strong">
              current
            </div>
            <div className="break-all">{current}</div>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          release <span className="font-mono">{releaseTag}</span> · digest{" "}
          <span className="font-mono">{releaseDigest}</span>
        </div>
        <Button variant="destructive" onClick={onApprove} className="w-full">
          I reviewed it — pin the new fingerprint
        </Button>
      </div>
    </CeremonyFrame>
  );
}

export function UnlockingScreen() {
  return (
    <CeremonyFrame>
      <div className="space-y-3">
        <div className="text-sm font-medium">Delivering your secret…</div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-duck" />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The key is generated and held on this device. It travels only through the channel the
          enclave just proved — and the enclave holds no lifecycle credentials of its own.
        </p>
      </div>
    </CeremonyFrame>
  );
}

export function LockedForm({
  keyInput,
  onKeyInput,
  hasStoredSecret,
  onUnlock,
}: {
  keyInput: string;
  onKeyInput: (v: string) => void;
  hasStoredSecret: boolean;
  onUnlock: () => void;
}) {
  return (
    <CeremonyFrame>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-base">🔐</span>
          <span className="text-sm font-medium">Locked — the enclave holds no key to your data</span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Unlocking generates a 64-byte secret on this device, delivers it through the attested
          channel, and derives every server-side key from it.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="inference-key" className="text-xs font-medium text-muted-foreground">
            inference key (Tinfoil, memory-only)
          </label>
          <Input
            id="inference-key"
            type="password"
            value={keyInput}
            onChange={(e) => onKeyInput(e.target.value)}
            placeholder="tk_…"
            className="font-mono"
          />
        </div>
        <Button onClick={onUnlock} className="w-full">
          {hasStoredSecret ? "unlock with stored secret" : "generate secret & unlock"}
        </Button>
      </div>
    </CeremonyFrame>
  );
}

export function AsleepScreen({
  waking,
  note,
  onWake,
}: {
  waking: boolean;
  note?: string;
  onWake: () => void;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center p-6 text-center">
      <DuckMark size={72} className="mb-6 text-muted-foreground/60" />
      <div className="mb-2 text-lg font-semibold tracking-tight">waddle is asleep</div>
      <p className="mb-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
        The instance is stopped. Nothing is running, and billing stopped with it.
        Your data is sealed in your own store.
      </p>
      {note && <p className="mb-4 font-mono text-xs text-muted-foreground/70">{note}</p>}
      <Button onClick={onWake} disabled={waking} size="lg" className="mt-4">
        {waking ? "waking…" : "☀️ wake waddle"}
      </Button>
    </div>
  );
}

export function ErrorScreen({
  message,
  onRetry,
  onForget,
  onWake,
}: {
  message: string;
  onRetry: () => void;
  onForget: () => void;
  onWake: () => void;
}) {
  return (
    <CeremonyFrame wide>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-gate-strong">⛔ connection failed</div>
        <div className="rounded-xl border border-border/70 bg-muted/40 p-3 font-mono text-xs break-all">
          {message}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onRetry}>
            retry
          </Button>
          <Button variant="outline" onClick={onForget}>
            forget secret & retry
          </Button>
          <Button variant="outline" onClick={onWake}>
            wake waddle (instance may be asleep)
          </Button>
        </div>
      </div>
    </CeremonyFrame>
  );
}
