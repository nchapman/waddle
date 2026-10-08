# waddle — agent notes

## Standing policies

- **Always do the deploy ceremony** after verified changes that touch the
  server image: buildx push → pin digest in /tmp/waddle-config
  (git repo, origin git@github.com:nchapman/waddle-config.git) → commit+push →
  `gh workflow run tinfoil-release.yml -f version=vN` (never manual
  `gh release create` — the platform 500s on it) → wait for the auto-triggered
  publish to attach tinfoil-deployment.json + tinfoil.hash →
  `tinfoil container update waddle --tag vN --yes` (env from `.env.local`;
  tinfoil CLI on `~/.local/bin`) → poll `/health` for *locked* → TOFU re-pin
  in the client → quick live smoke. Track the pinned config in
  `config/tinfoil-config.yml` in the same commit train.

## Local layout

- vite :5173 (dev/compose parity), :5174 (live mode); compose :8080
  (`docker compose down -v && up -d`); concierge :5390; betterbase-dev
  :5377/:5379. Test account waddler / iceflow-flipper-9.
- Evidence screenshots live under `.pi/evidence/` (never committed).
- Stray `.bak`/`.bak2` files are old debris — do not commit.

## Known open items (as of v0.0.19)

- Agent context does not survive boots (UI replays history; the pi session
  starts fresh). Planned seam: `session.sendCustomMessage(..., {deliverAs:
  "nextTurn"})` on history_restore.
- Browser tools: no scroll, and body links on long pages (wikipedia) fall
  outside the 80-element clickable index — the agent works around it by
  navigating directly (observed live).
- Live stream is jpeg-over-ws (~10fps); WebRTC is the production upgrade.
