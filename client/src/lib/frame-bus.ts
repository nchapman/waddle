/**
 * Frame bus: screencast frames bypass React state entirely.
 *
 * Frames arrive at up to ~25fps; routing them through App state re-rendered
 * the whole tree per frame (chat surface included) — the browser tabs burned
 * a core on it. The bus is a module-level pub/sub holding only the newest
 * frame; the dock/overlay subscribe and re-render just their <img>.
 */
export interface LiveFrame {
  data: string;
  seq: number;
}

const subs = new Set<(f: LiveFrame) => void>();
let last: LiveFrame | null = null;

export const frameBus = {
  publish(frame: LiveFrame): void {
    last = frame;
    for (const s of subs) s(frame);
  },
  /** New frame + immediate replay of the newest one (so a mounting dock
   *  isn't blank until the next damage-triggered frame). */
  subscribe(s: (f: LiveFrame) => void): () => void {
    subs.add(s);
    if (last) s(last);
    return () => subs.delete(s);
  },
  reset(): void {
    last = null;
  },
};
