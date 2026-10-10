/** One-shot answer with keyboard-first semantics (⏎ yes · esc no).
 *  Shared by the approval gate and the delegation warning — both must
 *  answer exactly once and never while the user is typing elsewhere. */
import { useEffect, useRef } from "react";

export function useOnceAnswer(onAnswer: (ok: boolean) => void) {
  const answered = useRef(false);
  const answer = (ok: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(ok);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        answer(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        answer(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return answer;
}
