# Native memory proofs — v0.0.21 (commit 17e3e01 + link-priority fix)

## Proof A — container restart, persisted volume (no relay, no digest)
- Told agent: favorite color teal, bicycle named Biscuit (plus it re-recorded 73/Pistachio).
- `docker compose stop` → `start`; session file /data/sessions/…01a11bfd….jsonl continued 17,048 → 22,532 bytes (same session id).
- Post-restart recall (no tools): "your favorite color is teal, and your bicycle is named Biscuit… re-recorded… favorite number 73 and cat named Pistachio."
- Mechanism: SessionManager.setSessionFile(newest) → createAgentSession native resume.

## Proof B — full scratch wipe (sessions + log deleted), betterbase relay
- Sleep (exit) → docker rm → wiped /data/sessions, /data/log, workspace → compose up.
- Unlock: log empty → client pulled betterbase envelope (now carries pi jsonl) →
  relayed session_restore (jsonl) then history_restore (rows).
- Lazy boot staged restore-*.jsonl → resumed verbatim: fresh /data/sessions file of
  16,820 bytes containing the original turns (grep teal → 2); agent recalled all
  four facts. Digest fallback NOT used (file holds real turns, not one custom message).

## Live v0.0.21 smoke (:5174)
- TOFU re-pinned; sealed log replayed; memory question answered from the resumed
  transcript — including v0.0.20's old digest as ordinary historical context
  ("last 60 turns … 155 older omitted" is the old digest text replayed natively).

## Browser proofs (this session)
- browser_scroll: en.wikipedia.org/wiki/Emu — agent scrolled thrice ("Page's open
  at the top…", "Reached the Taxonomy/History material…", "back up a little"),
  quoted verbatim from below the fold: "Although flightless, emus have vestigial
  wings, the wing chord measuring around 20 cm (8 in), and each wing having a
  small claw at the tip."
- Link priority: first five clickables on Emu = [0] Emu (disambiguation), [1–4]
  PreꞒ/Ꞓ/O/S (article body) — versus pre-fix (input toggle, Article, Talk tabs).
  Root cause: querySelector selector-list order is document order, so Vector's
  #content (which contains the page tabs) matched before #mw-content-text. Fixed:
  tightest container wins (#mw-content-text → article → main → [role=main] → #content).
- Snapshot header now states clickables cover the whole page (Playwright/DOM view),
  lowest indexes are main content, and page TEXT follows the scroll position.

## Gates
- pnpm check ✓ · pnpm build ✓ · pnpm test 15/15 ✓ (incl. 5 digest-bounds tests:
  empty-injects-nothing, role labels + header, elided-count note, per-row
  truncation, whole-digest char bound)
