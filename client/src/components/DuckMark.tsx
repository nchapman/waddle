/**
 * The waddle mark: a rubber duck, geometric and calm. currentColor so it
 * sits yellow on ink, ink on yellow, wherever it's needed.
 */
export function DuckMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-label="waddle"
      role="img"
    >
      {/* body: a settled oval, tail tipped up */}
      <path
        d="M14 40c0-9 7-15 17-15 1.7 0 3.3.2 4.8.6C37.4 21.5 40.4 19 44 19c4.4 0 8 3.6 8 8 0 1.5-.4 2.9-1.1 4.1 3.5 1.6 6.1 4.4 7.1 8.9.4 1.8-1 3.4-2.8 3.4H20c-3.3 0-6-2.7-6-6v3z"
        fill="currentColor"
      />
      {/* head */}
      <circle cx="44" cy="26" r="10" fill="currentColor" />
      {/* beak */}
      <path d="M52 24l9 2.5-9 3.5z" fill="currentColor" opacity="0.85" />
      {/* eye */}
      <circle cx="47.5" cy="23.5" r="1.8" fill="var(--background, #14181f)" />
    </svg>
  );
}

/** Small status chip for the shell header. */
export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "duck" | "warn";
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-secondary text-muted-foreground border-border",
    good: "bg-live/10 text-live border-live/30",
    duck: "bg-duck-soft text-duck border-duck/30",
    warn: "bg-gate/10 text-gate border-gate/40",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
