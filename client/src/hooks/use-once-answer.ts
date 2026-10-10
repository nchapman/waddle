/** One-shot answer with keyboard-first semantics (⏎ yes · esc no).
 *  Shared by the approval gate and the delegation warning — both must
 *  answer exactly once and never while the user is typing elsewhere. */
import { useEffect, useRef } from "react";

/** The key→answer decision (pure — the hook's testable core): ⏎ yes,
 *  esc no, null when the key is neither or the user is typing in an
 *  input/textarea. */
export function answerFromKey(e: { key: string; target: unknown }): boolean | null {
  const tag = (e.target as { tagName?: unknown } | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return null;
  if (e.key === "Enter") return true;
  if (e.key === "Escape") return false;
  return null;
}

export function useOnceAnswer(onAnswer: (ok: boolean) => void) {
  const answered = useRef(false);
  const answer = (ok: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(ok);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const verdict = answerFromKey(e);
      if (verdict === null) return;
      e.preventDefault();
      answer(verdict);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return answer;
}
