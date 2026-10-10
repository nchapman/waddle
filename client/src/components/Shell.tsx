/**
 * The shell: duck mark + status chips up top, then the working area —
 * chat on the left, the live browser docked on the right when frames
 * flow (the side-by-side demo shot). The store footer keeps the user's
 * data story visible.
 */
import type { ReactNode } from "react";
import { DuckMark } from "./DuckMark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Shell({
  statusChips,
  browserLive,
  onSleep,
  onToggleBackground,
  background = false,
  children,
  browser,
}: {
  statusChips: ReactNode;
  browserLive: boolean;
  onSleep: () => void;
  /** The delegation switch (two-tier autonomy) — amber when armed. */
  onToggleBackground: () => void;
  background?: boolean;
  children: ReactNode;
  browser?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border/60 bg-card/60 px-4 py-2.5 backdrop-blur">
        <DuckMark size={26} className="text-duck" />
        <span className="text-sm font-semibold tracking-tight">waddle</span>
        <div className="flex flex-1 flex-wrap items-center gap-1.5">{statusChips}</div>
        <button
          onClick={onToggleBackground}
          title={
            background
              ? "background tasks on — the enclave wakes and acts as you on schedule. Click to disable."
              : "background tasks off — nothing runs while you sleep. Click to enable (one-time warning)."
          }
          className={
            "rounded-full border px-2.5 py-1 text-xs transition-colors " +
            (background
              ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
              : "border-border/60 text-muted-foreground hover:text-foreground")
          }
        >
          {background ? "🌙 background on" : "🌙 background off"}
        </button>
        <Button variant="ghost" size="sm" onClick={onSleep} className="text-muted-foreground">
          💤 sleep
        </Button>
      </header>
      <main
        className={cn(
          "mx-auto flex min-h-0 w-full max-w-7xl flex-1 gap-4 p-4",
          browserLive ? "flex-row" : "flex-col",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {browserLive && browser && (
          <div className="hidden w-[38%] min-w-[380px] max-w-[560px] md:block">{browser}</div>
        )}
      </main>
    </div>
  );
}

export function StoreFooter({
  connected,
  handle,
  opening,
  onConnect,
}: {
  connected: boolean;
  handle?: string;
  opening: boolean;
  onConnect?: () => void;
}) {
  return (
    <footer className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
      <span>☁️</span>
      {connected ? (
        <span>
          betterbase: <span className="text-foreground/80">{handle ?? "signed in"}</span>
          {opening ? " · opening store…" : " · store connected"}
        </span>
      ) : (
        <>
          <span>betterbase: not connected</span>
          {onConnect && (
            <button onClick={onConnect} className="text-duck underline-offset-2 hover:underline">
              connect your store
            </button>
          )}
        </>
      )}
    </footer>
  );
}
