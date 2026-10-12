# Wake scheduling — live prod proof (2026-10-09)

The full unattended-ish cycle on prod tinfoil, one day after the dev E2E,
waddletest2@betterbase.dev, waddle v0.0.37 + concierge v0.2.3.

## Cast

- `waddle` — v0.0.37 (`sha256:7e230fe7…`), measured at waddle-config@v0.0.37,
  snp_measurement `e9c2f601e8c5…0d906d4a`, org secret CONCIERGE_SHARED_SECRET
- `waddle-concierge` — v0.2.3 (`sha256:99808d31…`), its own deployment +
  config repo (nchapman/waddle-concierge-config), egress allowlisted to
  `api.tinfoil.sh` only, org secrets TINFOIL_ADMIN_KEY + CONCIERGE_TOKEN,
  memory-only timer table, tinfoil CLI 0.19.0 baked in

## The cycle (timestamps UTC, from /debug/log ring + concierge /status)

1. 19:41:38 — unlock (stored secret, tk_ inference key, prod bb grant):
   restore gate fresh → `machine restored from shelf` on the first boot;
   `concierge handshake {ok:true, via:"shared-secret"}` (the v0.0.35
   fallback fix, live) → stop backstop armed idle+30s = 615 s out.
2. 19:42:30 — agent schedules via its own `schedule_create` tool:
   id `0945ebff…`, one-shot 19:55:30Z ("live wake test").
3. 19:43:20 — user closes the tab (socket drops).
4. ~19:52:40 — idle gate (600 s): checkpoint → final shelf push →
   death flare (stop @+5 s) + wake row (job `0945ebff…`, due 122 s out
   at 19:53:27 observation) → process exit → zombie "Running".
5. 19:55:30 — wake row fired; the concierge's deploy initially failed
   silently (see bug below), recovered at 20:10 via `/wake`:
   `(zombie recovered)` — stop → poll → deploy, fresh CVM.
6. 20:11:29 — unlock on the fresh boot: `machine restored from shelf
   {gen:22, events:5}` (full transcript + schedules.json; pi session
   resumed natively), handshake via shared-secret, initial push fa4873e5.
7. 20:11:34 — due-ticker fired the overdue one-shot **3 s** after the
   socket connected: agent replied "Wake test worked — I'm up. 🦆",
   ran `schedule_list` (row `done … last run 20:11:34`), sealed in the log.
8. Steady state: stop row re-armed, wake jobs empty (one-shot exhausted).

## Bugs the live ceremony flushed out (each fixed + verified live)

- **Stop-lease race** (dev E2E, pre-release): arming the platform stop at
  60 s while the idle gate waits 120 s let the concierge SIGKILL the
  machine before its own checkpoint-exit. The stop row is a zombie
  backstop now: always idle+30 s from last contact, replaced by the 5 s
  death flare at the gate.
- **Missing system CA bundle** (live, concierge v0.2.1→v0.2.3):
  `node:24-slim` ships `/etc/ssl/certs` empty; Node bundles its own roots,
  the Go tinfoil CLI does not → every platform verb failed with
  `x509: certificate signed by unknown authority` while fire-and-forget
  rows consumed silently. Fix: `ca-certificates` in the image. The
  `/wake` error surfaced it verbatim; `(zombie recovered)` proves the fix.
- **bb-JWT-only handshake** (live, waddle v0.0.35): with a bb grant armed,
  the handshake sent only the 15-min JWT; the concierge (no JWKS yet)
  401'd and the whole timer path stayed dead. Fix: fall back to the
  shared secret; `via:"shared-secret"` in the ring is the fix working.
- **YAML quote casualty** (ceremony): a sed digest-swap ate the image
  line's closing quote → "mapping values are not allowed" at line 11,
  two burned release tags (v0.0.35/36) before the real cause was visible.
- **Vite env precedence** (client): `.env.development` overrides
  `.env.local` in dev mode — live env must go in `.env.development.local`
  (plus the prod bb client id `d096d76d…`, recovered from the session
  record after my `.env.local` rewrite dropped it).

## Known seams (follow-ups, not blockers)

- Server-fired turns (scheduled runs) don't append to the live thread —
  they're in the sealed log and /state; a page reload renders them.
- Page reload re-sends the last user message (the agent fielded the
  scheduling request twice; it declined to double-book).
- Unattended autonomy stays parked: on tinfoil every deploy is a fresh
  volume, and the wake-credential (excluded from the shelf by design)
  dies with the CVM — wake-boots are user-in-the-loop until the escrow /
  renewal-token design lands (PLAN.md).
- The concierge /health version string reads 0.2.1 (constant not bumped
  with the image tag); cosmetic.

## Incident + fix: the gate that raced its own unlock (v0.0.38 → v0.0.39)

**The bug** (found live on prod, 2026-10-09 20:43): the activity clock
initialized at BOOT, but the gate only checks the lock state — so an
enclave that sat locked longer than the idle window (prod deploys take
minutes) was reaped the moment its first unlock flipped `unlocked`,
mid-restore, before any WebSocket existed. Signature: a shelf whose
chain head is an empty gen holding one `sleep "idle 120s"` event
timestamped DURING the unlock — the final checkpoint clobbered the
live gen-22 machine (content survives behind it in the bb store;
anchor 1c3bf4d6, recovery parked). Compounding it: the idle default
was 120 s (a dev convenience that shipped), making the race certain.

**The fix** (v0.0.39, regression-proven):
- `lastActivity` starts null — the clock begins at first client
  contact (unlock stamp / WS connect / sink events), never at boot.
- `restoring` guard: the gate never fires while an unlock (bb grant +
  shelf restore + handshake) is in flight.
- Idle default 600 s; prod config sets `WADDLE_IDLE_MS: "600000"`
  explicitly.
- Regression script: `locked-idle-regression.mjs` (boot → 150 s
  locked-idle → unlock → must survive to idle-from-unlock, then sleep
  gracefully). Green on v0.0.39 (unlock 20:56:01 → sleep 20:58:09,
  event delivered to the silent client, exit 0).

## Wake latency, measured (2026-10-09, v0.0.39/v0.0.40)

Page-load → chat-ready, resource-timed from the browser:

| phase | t | cost |
|---|---|---|
| probe fails, auto-wake POST /wake | +2.2s | — |
| **tinfoil container deploy (via concierge)** | +2.2→76.2s | **74s** |
| first health poll OK | +78.2s | ~2s cadence |
| attestation → unlock screen | ~+80s | ~2s |
| unlock (bb grant + shelf restore + handshake) | +127.1s | **6.7s** |

The platform deploy is 85–90% of the whole path (three samples: 42s
human-timed, 73s CLI-timed, 74s concierge-timed — concierge adds ~1s,
deploy cost is platform-side). Client-side sequencing (probe, poll
cadence, serialized attestation) is ~6s total — polish, not the lever.
Real levers: warm window (doze state, hold the exit N min), scheduled
pre-wake rows, or a standby instance (doubles idle spend). Also proven
tonight: the manual 💤 sleep button (click 21:22:19 → Stopped 21:23:06,
graceful checkpoint + flare), and a second user's uncoordinated wake.

## Instance-provided inference (v0.0.40)

TINFOIL_API_KEY moved from client-delivered-at-unlock to a tinfoil org
secret in the config's secrets list — the server already read
process.env.TINFOIL_API_KEY (initAgent just sets it), so zero code
changed. Proven live: unlock with an EMPTY key field on v0.0.40 →
agent answers ("17×23 → 391") on the boot-time env key. This is what
makes unattended wake-boots possible: a scheduled task can now think
without any human unlocking. The client field remains as an optional
override (BYOK) — blank means instance-provided. Note: config changes
re-measure (secrets list is part of the measurement) → TOFU re-pin on
v0.0.40 was expected. Remaining proof: the unattended ceremony
(schedule → sleep → wake row → task runs, no unlock, re-sleep).

## Wake latency, measured (2026-10-09, v0.0.39/v0.0.40)

Page-load to chat-ready, resource-timed from the browser:

| phase | t | cost |
|---|---|---|
| probe fails, auto-wake POST /wake | +2.2s | - |
| tinfoil container deploy (via concierge) | +2.2 to 76.2s | 74s |
| first health poll OK | +78.2s | ~2s cadence |
| attestation to unlock screen | ~+80s | ~2s |
| unlock (bb grant + shelf restore + handshake) | +127.1s | 6.7s |

The platform deploy is 85-90% of the whole path (three samples: 42s
human-timed, 73s CLI-timed, 74s concierge-timed — the concierge adds
~1s; deploy cost is platform-side). Client-side sequencing (probe,
poll cadence, serialized attestation) is ~6s total — polish, not the
lever. Real levers: warm window (doze state, hold the exit N min),
scheduled pre-wake rows, or a standby instance (doubles idle spend).
Also proven tonight: the manual sleep button (click 21:22:19 to
Stopped 21:23:06, graceful checkpoint + flare) and a second user's
uncoordinated wake+unlock.

## Instance-provided inference (v0.0.40)

TINFOIL_API_KEY moved from client-delivered-at-unlock to a tinfoil org
secret in the config secrets list — the server already read
process.env.TINFOIL_API_KEY (initAgent just sets it), so zero code
changed. Proven live: unlock with an EMPTY key field on v0.0.40, agent
answers (17x23 -> 391) on the boot-time env key. This is what makes
unattended wake-boots possible: a scheduled task can now think without
any human unlocking. The client field remains as an optional override
(BYOK) — blank means instance-provided. Note: config changes
re-measure (the secrets list is part of the measurement), so the TOFU
re-pin on v0.0.40 was expected. Remaining proof: the unattended
ceremony (schedule, sleep, wake row fires, task runs with no unlock,
re-sleep).

## Warm-standby pool: design validated (2026-10-09 21:52)

The multi-user shape: concierge + N warm standbys (blank, locked,
env-inferred, zero user state). A user arrival gets a standby ASSIGNED
(URL handout); their secret makes it theirs (unlock + shelf restore);
a replacement standby boots in the background. TTL drops unclaimed
warm machines. Proven live, end to end, with zero pool code:

- `tinfoil container create waddle-standby-1 --repo nchapman/waddle-config
  --tag v0.0.40` — second instance from the same config, 77s to live.
- Client repointed at it: TOFU pin HELD (same config = same measurement,
  no re-pin) — attestation travels across instances.
- Unlock on the standby restored the user's full state (gen 38, 29
  events — including an earlier session's chat) from a machine that
  booted blank 56s earlier; handshake ok; initial push ok.
- Latency: page load to live chat ~17s (10s attest+unlock-screen, 7s
  unlock+restore) vs ~87s via the deploy path. The 77s replacement
  boot hides behind the user's session.

Build notes (concierge grows a tiny scheduler, still metadata-only):
- machines table {name, state: warm|serving|stopped, claimed_at, ttl};
  /assign endpoint; TTL sweeper; background replacement boots;
  health-first wake (a wake row finding a live machine no-ops instead
  of the zombie stop-deploy dance).
- Env knobs, per request: WARM_POOL_SIZE (default 1),
  STANDBY_TTL_MINUTES (default 60), STANDBY_CREATE_TIMEOUT_S.
- Per-instance WADDLE_INSTANCE (tinfoil create --variable) — pool
  machines must not handshake under a colliding instance name (the
  experiment's standby handshook as "waddle" and clobbered the real
  machine's stop row; harmless tonight, a real bug in a pool).
- Doze (single-user warm window) is subsumed: a pool of one. Doze is
  cheaper at k=1 user; the pool amortizes 1/k machines per user as k
  grows.
- Scheduled tasks still can't read the user's shelf unattended (the
  escrow problem is unchanged — pool solves return latency, not
  unattended data access).

## 2026-10-09 23:15 UTC — the full pool ceremony, live (concierge v0.3.2→v0.3.4)

End state proven: primary stopped → client page load auto-falls-back to
/assign → warm standby-6 → v0.0.41 measurement verifies, TOFU pin holds
(no fingerprint screen) → unlock with stored secret, blank inference key →
full shelf restored (entire conversation archive) → live chat answered
through the standby. The 77s boot hides behind the pool; the user-visible
path is ~10s verify + ~7s unlock/restore.

Three live-caught findings shaped v0.3.3/v0.3.4:

1. **Per-instance --variable breaks measurement (v0.3.2, standby-1).**
   tinfoil create --variable changes the code measurement → the client
   refused ("Code measurement mismatch") against the signed release —
   the security model working exactly as designed. v0.3.3: standbys run
   the exact committed config, no variables. Per-machine identity is an
   open design item; interim bounds on a claimed machine are the
   concierge-side grace row (default 12h, STANDBY_CLAIM_GRACE_MS).

2. **Tagless deploy = version skew (v0.3.3, caught by standby-3).**
   The CLI verified standby-3 clean against v0.0.41, but a browser load
   fell through to /wake, whose deploy was tagless → the primary booted
   its SAVED v0.0.40 → client expects latest (v0.0.41) → correct refusal.
   v0.3.4: /wake and zombie-recovery deploy with --tag, defaulting to
   STANDBY_CONFIG_TAG (CONCIERGE_DEPLOY_TAG overrides). Live-proven:
   /wake booted the primary at v0.0.41 and the pin re-pinned cleanly.

3. **Concierge restart churn double-boots.** Each concierge restart
   orphans in-flight replacement boots (memory-only tables): v0.3.3→v0.3.4
   left standbys 2 and 4 untracked and burning. Name recycling works
   (standby-1 was reborn after deletion, tracked by the fresh concierge).
   Cost: one extra boot per restart-with-pending-standby; cleaned by hand
   tonight; a future adopt-live-standbys heuristic would close it.

Also live-proven tonight: assign-404 → /wake fallback in the browser
(standby not yet warm at page-load — tick lag), locked-boot stop backstop
rows appearing on every standby boot ("waddle" shared-identity collision,
harmless as designed: the row stops an already-stopped primary), and
instance-provided inference through a pool machine (blank key field,
agent answered — and correctly cannot see its own host identity or key).

Standing cost note: the pool's steady state is one warm machine, always.
WARM_POOL_SIZE is measured config — changing it re-measures the
concierge. Overnight economics are a user decision, not a code one.

## 2026-10-10 00:16–00:29 UTC — the unattended ceremony, live (waddle v0.0.43 + concierge v0.3.5–v0.3.7)

The parked design, proven end to end with zero persistent infrastructure —
the credential lives in the concierge's MEMORY:

- 00:10:33 unlock (client, stored secret, blank inference field) → the
  machine armed the handoff: POST /handoff → memory row. /status showed
  `wake_handoff.armed: true` seconds later. (First arm attempt at 23:58
  failed silently: the concierge shim didn't forward /handoff — fixed in
  v0.3.7. Found by /status, not by luck.)
- 00:11–00:13 scheduled the proof task via chat (agent tool
  `schedule_create`, job 30cf083a, fires 00:16:32Z).
- 00:13:16 manual 💤 sleep → gate wrote the wake row (+3min) → checkpoint
  → death flare → machine Stopped 00:14. Nothing running anywhere.
- 00:16:42 concierge wake row fired → markWakeFired → deploy v0.0.43.
- 00:18:13 machine up `"locked":false` — the boot pulled the fire-gated
  handoff and self-unlocked. Nobody touched anything.
- 00:28–00:29 idle gate (600s) fired → machine re-slept itself. Burn
  bounded; handoff still armed in memory for the next cycle.

State-level proof complete: stop → fire → deploy → self-unlock → run →
re-sleep. The shelf-level proof (the AUTONOMY-PROOF reply line) was
blocked by an ATC outage (atc.tinfoil.sh 500s for the expected-measurement
fetch, ~00:29+) — to be read back at the next unlock when ATC recovers.

Live-caught along the way:
- A sleep with no live concierge session (post-restart) skips the death
  flare AND wake rows: process dies, container zombies Running until the
  backstop stop row reaps it; the client's /wake cleared that backstop row
  (userWake) and the zombie-recovery loop didn't land — manual stop+deploy
  recovered. The client's "resume session" on a zombie read a stale
  locked:false. Client bug filed: after /assign the SDK's pinned fetch
  still targets the primary ("refusing to send request… bound to the
  verified enclave/proxy").
- Release tooling: runner gh CLI can lag the measure-action's 2.67.0
  floor — both config repos' publish workflows now self-install current
  gh. And sed ate a closing YAML quote during a digest bump (use python).
- STANDBY_CONFIG_TAG must track every waddle release (standby-create
  skew = the same client-refusal class as the deploy skew fixed in
  v0.3.4). Treadmill noted: every waddle release implies a concierge
  config bump + release.

### Post-mortem addendum (00:36 UTC): the autonomous run's output did not survive

The 00:35 unlock restored the shelf only up to the 00:13 manual sleep —
no "[system] autonomous boot" event, no AUTONOMY-PROOF line. Root cause,
confirmed in code: BOTH the restore pull and the sleep-time shelf push
are gated on `bbGrantActive()`, and `setBbGrant` runs only in the client's
unlock POST (the client supplies a fresh betterbase JWT). An autonomous
boot has no grant: it self-unlocked into an EMPTY log, ran the due task
(state-timing consistent), then idle-slept without pushing — the run
existed only in that machine's memory and died with it.

So the honest scoreboard for the unattended ceremony:
- PROVEN (state-level, observed): stop → wake fire → deploy → fire-gated
  handoff pull → self-unlock (locked:false at 00:18) → idle re-sleep at
  00:29. The escrow, gate, and lifecycle all work.
- GAP (design): autonomous output needs a survival path. Options inside
  the memory-only constraint: (a) the concierge as postbox — autonomous
  machines POST their event tail at sleep; the next unlock merges it
  (extends the handoff pattern; the concierge stays metadata+sealed-blob
  only); (b) a machine-capable bb grant in the armed credential (bigger
  escrow blast radius — needs the privacy review's blessing); (c) accept
  loss (dishonest for real scheduled work — rejected).

## 2026-10-10 00:29–01:33 — SME hardening, and the race the fix inverted (v0.3.8 → v0.3.10)

Privacy + security SME reviews ran against the v0.3.7 design. Verdicts:
the privacy reviewer said do-not-ship-as-is (the fire gate was decorative:
any external-tier /timer write could mint a fire and pull the escrow); the
security reviewer found a standby-steal race (a racing boot could win the
one-shot pull, self-unlock, and idle forever) and an unauthenticated
/status. All findings implemented (commit 6bf610a, waddle v0.0.44 +
concierge v0.3.8):

- /timer is session-tier only; /status requires the shared secret;
  GET /handoff replaced by POST /handoff/pull + no-store (caching/URL
  secrets); constant-time secret compare.
- Release window opens ONLY after the schedule deploy succeeds, 3-min
  TTL; failed deploys re-arm the row (3 tries); the pool defers fills
  while a window is open (canFill).
- Escrow TTL = next-due + margin, armed at the sleep gate (recurring
  schedules work; arm skipped with nothing pending); disarm verb
  (clear:true); leftover Running machines adopted, not reaped blindly.
- Restricted autonomous mode: credential-unlocked machines run schedules
  only (chat/browser intents refused); a user unlock takes over.

Then the 01:00 hardened cycle caught MY fix's own bug, live: the boot's
escrow pull lands at ~+90s (app up), which BEATS the deploy CLI's own
resolve — marking the fire only after the deploy resolved meant the
intended machine pulled `no-fire` and booted locked (machine handshook
01:23:42Z, escrow still armed, job spent). Fix (v0.3.10): the window
opens at FIRE time; the standby-steal vector stays closed by the pool's
canFill deferral (no replacement boots while a window is open), and a
failed deploy re-arms its row while the stale window harmlessly expires.
Lesson recorded: ordering fixes need the whole timeline, not just the
attacker's — the defender's happy path can race too.

Operational notes from the same stretch: the shim allowlist bit again
(renamed /handoff/pull 404'd at the gateway until v0.3.9 forwarded it),
and an AdGuard-Home negative-cache (NXDOMAIN for exactly one enclave
host, poisoned from Quad9 during a network flap, 30-min TTL; re-poisoned
once by a probe fired between cache-clear and upstream recovery) blocked
client attestation for ~40 min — diagnosis via dig against each resolver
in the chain, plus the user's AdGuard query log.

## 2026-10-10 04:06–04:23 UTC — the hardened unattended cycle, live (waddle v0.0.44 + concierge v0.3.10)

Zero persistent infrastructure, memory-only escrow, every hardening on:

| UTC | event |
|---|---|
| 04:06:57 | manual 💤 (attended): checkpoint → stop → escrow armed (job 2bbb9a03 pending) |
| 04:09:55 | machine Stopped; nothing running anywhere |
| 04:11:00 | wake row fired → release window opens AT FIRE (v0.3.10) → deploy v0.0.44 |
| 04:12:36 | booted `"locked":false` — the pull landed IN the window; restricted self-unlock |
| ~04:12:40 | ticker ran "hardened proof 4" (prompt: reply exactly `HARDENED-AUTONOMY-4 ok`) |
| 04:23:02 | 10-min idle gate → checkpoint → stop → re-sleep |

The inverted race is dead: 96s fire→unlocked, pull in-window on the first
try. The restricted mode held for the run window, and the machine put
itself away — total unattended burn ~11.5 min, bounded by the idle gate.

Read-back (the shelf-level line) blocked AGAIN by an ATC outage
(atc.tinfoil.sh 500 "Failed to build attestation bundle", 04:26+;
fail-closed client refuses to verify without it). Expected behavior per
the eventual-consistency property observed at 00:35: the schedule
persists in the shelf (the autonomous run's done-marker dies with the
unpushed log), so the NEXT unlock re-fires proof-4 attended and the
HARDENED-AUTONOMY-4 line should appear then. To be appended once ATC
recovers. Also wiped by the user's reboot: the /tmp copy of the shared
secret (only the tinfoil vault holds the value now — `secrets get`
never returns it; rotation available at the cost of a re-measure+
re-pin cycle if /status access from the laptop matters again).

### Read-back complete (04:29–04:32 UTC, ATC recovered)

ATC came back at 04:29:14; retry → verify → unlock. The shelf restored,
and the ticker fired BOTH overdue schedules at +3s each (proof-3 had
also survived unfired from the 01:22 failed window):

```
[scheduled: hardened proof 4] Unattended hardened run 4. Reply with
                             exactly: HARDENED-AUTONOMY-4 ok.
HARDENED-AUTONOMY-4 ok
```

Verbatim DOM extract: .pi/evidence/wake/hardened-autonomy-4-readback.txt
(screenshot capture times out on the live-stream element — DOM extract
instead). One client quirk re-confirmed en route: the re-fired proof-4
turn appended server-side but needed a page reload + "resume session"
to render (the parked "server-fired turns need reload" bug; proof-3's
render on the live socket was the restore-replay, not the stream).

Honest attribution, same as the 00:36 post-mortem taught: this line is
the RE-FIRED copy (04:30:0xZ, attended unlock) — the 04:12 autonomous
machine's own output died with it (bb-grant gap, known and accepted at
k=1). What the line nevertheless proves end-to-end: the schedule
survived sleep → fire → deploy → restricted run → re-sleep → next
unlock in the user's own store, and the task's reply reached the user
with zero human action at fire time. Output survival (postbox) remains
the parked design fix, not a regression.

## Proof 5 — schedule-scoped key + postbox (the sign of life), 2026-10-10 14:08–14:38Z

Waddle **v0.0.45** (46ebdc1a), concierge **v0.3.12** (33fddb2b, STANDBY_CONFIG_TAG=v0.0.45,
shim paths += /handoff/post, /handoff/post/pull).

**Escrow:** at 💤 sleep 14:10:26Z the machine armed `{autonomyKey, schedules[]}` —
HKDF(master,"autonomy") only. The master secret and inference key never travel.

**Unattended cycle (no user, no master on the machine):**
- 14:13:00Z — concierge fires, deploys with the escrow
- 14:14:22Z — `/health` → `locked:false` — the boot self-unlocked from the subkey
  (boot log: "autonomous boot — unlocked from wake credential (restricted mode)")
- ~14:16Z — run completes; 14:25:57Z — idle gate fires, machine seals
  `{events[], schedules[], cancelledIds[]}` with the subkey and POSTs it to the
  concierge `/handoff/post`, then stops

**Read-back at next unlock (14:38Z)** — postbox pulled inside the unlock POST and
merged before the ticker could re-fire. DOM extract (inner​Text counts):

- `[scheduled: sign of life proof]` → **1** occurrence (exactly-once delivery, no re-fire)
- `SIGN-OF-LIFE ok` → 3 total = 1 delivered answer + 1 in the user's booking message
  + 1 in the scheduled prompt echo — one true delivery
- system marker: `[system] postbox merged — 4 events from the unattended run delivered`
- transcript tail, in order: booking → "Scheduled, nothing else called. 🦆" →
  `[system] autonomous boot` → scheduled prompt → **SIGN-OF-LIFE ok** → postbox-merged marker

**Also proven this session:** subkey unlock leaves the master's verifier untouched
(55 server tests incl. `Lock.unlockAutonomous`), cancel tombstones survive the merge,
takeover re-seals the autonomous log into the master log, wrong-key log read throws.

Incidents during the ceremony (both external): Quad9 NXDOMAIN for the enclave domain
(recovered 07:32:44Z), ATC 500 "Failed to build attestation bundle" 14:26–14:37Z
(recovered on its own; unlocked on first retry after).

## Proof 6 — two-tier autonomy: full delegation + context snapshot, 2026-10-10 19:07–19:29Z

Waddle **v0.0.47** (22a5e14, image `sha256:001ac45d…`), concierge **v0.3.14**
(STANDBY_CONFIG_TAG=v0.0.47, WAKE_RELEASE_WINDOW_MS=10min). The proof the whole
two-tier design was built for: the escrow carries the **master** secret,
schedules, and a **sealed context snapshot**; the unattended boot restores the
machine's own memory and acts as the user.

**Attended leg (19:07Z):** unlock on v0.0.47, 🌙 background on (preference rides
the unlock), booked "snapshot proof 4" (`d034b8d0-ad03-4896-910a-f9fdeb7eb117`)
for 19:12:00Z — sleep+3.5min (see incidents). The planted fact from the 18:33Z
session was still in place: `ceremony-secret.txt` = `SNAPSHOT-PASSPHRASE:
MARIGOLD-TANGO-7741` (workspace, verified by read tool).

**Unattended cycle (nobody at the keyboard):**
- 19:08:13Z — 💤 sleep: escrow armed `{master, schedules, context snapshot}`
  (snapshot = archive minus `browser/`, sealed HKDF(master,"waddle/snapshot"));
  machine stopped ~19:08:45Z
- 19:12:00Z — concierge fires; deploy; boot stages done 19:12:49Z
- **19:13:19Z — `/health` → `locked:false`** (poller t-mv2roo5h caught it)
- Boot log (session-gated /state capture, 19:19Z, saved as
  `two-tier-proof6-machine-log.json`): **"[system] autonomous boot — state
  restored, verified unlock, acting as user (background tasks)"** — snapshot
  restore + successful unlock = the escrowed master matched the restored
  verifier (v0.0.47's honest marker; `enrolled:true` alone can't prove this)
- The runs: overdue "snapshot proof 3" fired immediately (the overdue-row
  floor) + "snapshot proof 4" at due. Each: read tool ONLY, relative path →
  **"SNAPSHOT-PROOF: SNAPSHOT-PASSPHRASE: MARIGOLD-TANGO-7741"** + "Workspace
  booted intact — file present at the relative path, read cleanly with the
  read tool only." The workspace file came **back from the sealed snapshot** —
  the context leg proof 2's context-free boot honestly ENOENT'd on
- 19:26:30Z — idle backstop reaps; sleep gate seals this boot's delta and
  POSTs the postbox

**Read-back (19:28:16Z):** client wake + unlock (shelf restore + postbox
merge). Log counts (session /state, 166 events): each scheduled reply exactly
**once**, one merge marker: **"[system] postbox merged — 4 events from the
unattended run delivered"** (4 = both prompts + both replies). DOM extract:
`two-tier-proof6-dom.json`. No re-fire, no duplicates.

**Incidents en route (attempts 2–3 → the lessons that shaped attempt 4):**
1. **Attempt 2 (17:44Z), oversize snapshot:** whole-machine archive on a
   lived-in box is tens of MiB (browser profile) → tripped the 768KiB arm cap
   → context-free boot → the run's read honestly returned ENOENT. Fix
   (22a5e14): the escrow snapshot is CONTEXT (log, verifier, workspace,
   schedules, prefs), `browser/` excluded; the shelf still serves
   full-profile restores when attended.
2. **Attempt 3 (18:43Z), stale-release treadmill:** `container update
   waddle-concierge --tag v0.3.13` re-deployed the tag's FROZEN config — the
   STANDBY_CONFIG_TAG=v0.0.47 bump on main never reached the concierge, so a
   replacement deployed the main instance at v0.0.46 ~4m18s after the sleep
   stop; the fire then hit `ensureInstance` → "already running" → occurrence
   consumed, no boot. Two lessons: every STANDBY_CONFIG_TAG bump needs a
   version bump + release (v0.3.14); book fire ≤ sleep+3.5min so the deploy
   wins the race.
3. The client **correctly fail-closed** on measurement mismatch when the
   stray ran v0.0.46 under a v0.0.47 pin — the TOFU pin doing its job.
4. AdGuard single-name NXDOMAIN poison (18:02–18:30:50Z) blocked only the
   browser; curl via `--resolve` kept working; healed at TTL expiry.

## 2026-10-10 21:45–23:59 UTC — the v0.0.48 deploy night: DNS teardown proved, the two designed reaps, JWKS live

**Deploy train:** waddle v0.0.48 (cleanup + /health version wiring) + concierge
v0.3.15→v0.3.20 (platform seam + ensure modes, bb-JWT external tier, secret-only
escrow routes). Both /health endpoints now report their true package versions.

**DNS mechanism, proved at Cloudflare's authoritative NS:** stop = DNS teardown
(`dig @harley.ns.cloudflare.com` on a Stopped instance → NXDOMAIN aa; the two
Running standbys → NOERROR). Deploy re-adds the record in ~90s. SOA negative TTL
is 1800s, so every resolver that queries during a sleep caches NXDOMAIN ≤30min —
the "browser can't reach a freshly-woken machine" class is structural, not flaky.
Decision (PLAN.md): machines are cattle — per-boot `waddle-<rand>` names, client
discovery via the concierge, TOFU anchored on zone+measurement. The browser-side
DNS workaround attempt was rejected by the user (correctly — treat the disease).

**The two "mystery stops" of a fresh deploy are both designed:**
1. old concierge's backstop sweep (table entry from proof 6, ~28h quiet > 24h
   HARD_STOP) stopped the first boot within minutes;
2. the locked-boot stop backstop (WADDLE_IDLE_MS+30s = 10.5min) stopped the
   second at exactly boot+10.5min (22:02:52Z Running → 22:13:34Z Stopping).
A deployed-but-unattended machine lives ~10.5min by design.

**JWKS leg, live-verified:** browser wake with a betterbase session →
`/wake` 401 at v0.3.16 (issuer mismatch: prod tokens stamp iss=
https://betterbase.dev, the apex — compose default accounts.betterbase.dev is
wrong) → fixed at v0.3.17 → wake 202 → concierge deploy → boot → attestation →
TOFU re-pin (pinned 33d8a8fb… → current a80d1058…, release v0.0.48 verified
against the config repo's latest) → lock screen. Client wake verified to the
unlock form; the unlock itself is the user's secret.

**ensure() lessons (the review loop):** the health probe needs egress for the
instance zone (added); user mode (/wake) must NEVER stop a silent Running
machine — probe failure cannot distinguish dead agent from blocked egress — the
stop+redeploy dance is fire-mode-only (150s probe > ~90s boot, so a replacement
booting in-window is left to become the scheduled boot); a dotted TAG (v0.3.18)
in a drifted DOMAIN column must not become a probe host (alphabetic-last-label
guard); deploy failures propagate instead of re-running.

**Open at 23:59Z:** concierge update wedged at the platform's certificate stage
×5 (ACME suspicion); v0.3.17 serving (blue-green, no outage), v0.3.19/0.3.20
released and pending deploy. Exposure window note: v0.3.16/17 have JWKS on with
the escrow routes still external-tier — nothing was armed (rows:0) during the
window, so no escrow was at risk.

## 2026-10-11 01:21–01:35Z — v0.3.22 deployed; the firewall-poison root cause; non-destructive wake proven live

**The deploy wedge, root-caused (23:10Z–01:21Z, six failed updates):** the
platform builds the egress firewall by RESOLVING every allowlist hostname at
deploy time. v0.3.18's config allowlisted the zone apex
(`ddg-waddle.containers.tinfoil.dev` — no A record) → "certificate"-stage
failures on blue-green updates. v0.3.21 allowlisted the concrete instance host
instead → "firewall"-stage failure, because the machine was STOPPED and
stop = DNS teardown → NXDOMAIN. Both classes are the same bug: hostname
allowlists cannot express instance hosts. v0.3.22 dropped the entry (probes
are best-effort; fires degrade to always-dance — correct, one wasted boot)
and the update landed clean first try. AGENTS.md + PLAN.md carry the lesson
and the wildcard/CIDR platform ask.

**Non-destructive /wake, proven live (proof 7):** machine Running at v0.0.48
(boot ~01:23Z after a first /wake whose deploy raced a stale platform
deployment → one 502, deploy landed anyway); second /wake at 01:33Z →
`202 {"detail":"already running (probe failed — left running): waddle"}` —
the probe is egress-blocked (by design now), user mode reports and leaves
the machine alone; container list confirms no stop/redeploy (same Running
boot). The first /wake's 409 ("cannot deploy a started instance") was a
double-fire race, not the zombie class.

**The DNS churn bit the client exactly as documented:** public DNS healthy
(1.1.1.1 → 69.46.85.219; /health via the resolved IP answers, locked), local
resolver chain served cached NXDOMAIN all through the machine's stopped
hours — the browser could not connect before the 10.5-min locked-boot
backstop would reap it. Structural (shared name + stop=teardown + 1800s
negative TTL); the cattle plan (per-boot names) is the fix.

## 2026-10-11 01:50–03:05Z — cattle discovery live-proven; the DNS class answered structurally

**Proof 8 — discovery end-to-end (concierge v0.4.3):** browser (bb session) →
auto-wake → `POST /boot` (JWT) → rebind `waddle-ud3b16438-777d2b` → deploy →
concierge-side readiness (`/boot/ready`: Running + c-ares DNS) → the client's
FIRST-EVER queries of the machine are 200s (`/health`: locked, v0.0.48) →
attestation (pin held — same measurement) → **lock screen**. No manual DNS
workarounds, no poisoned caches, no fallback to the legacy primary.

**The class, finally named (user challenge: "still fighting DNS"):** the
platform tears down a stopped machine's record and re-adds it seconds after
boot; SOA negative TTL 1800s. Every machine name has a dead window, and any
resolver querying inside it — Chrome's internal cache included (proved 02:30Z:
record live on every resolver a shell can dig, browser still blind) — caches
NXDOMAIN for 30min. Server-side gates narrow the window but cannot close it;
the poison lands in caches we don't control. The shippable answer: **the
browser never learns a machine name until the concierge proves it live**
(/boot gates on Running + cache-free DNS; the client polls /boot/ready on the
always-on concierge; a client that watched a machine die asks for a fresh
name — its old one may sit poisoned in its own cache). The root answer is a
platform ask: a wildcard zone record (stopped machines RST instead of
NXDOMAIN; resolvers cache only positive answers) — drafted in PLAN.md.

**Intermediate failures, for the record:** 01:53Z — fresh mint Running but
browser-unreachable (the client's own boot polls poisoned the chain; fixed by
/boot waiting on Running, v0.4.1); 02:30Z — rebind deploy returned before the
record existed; Chrome's internal cache held the NXDOMAIN even as dig showed
live records everywhere (fixed by concierge-side readiness + fresh-mint,
v0.4.2/3).

## Proof 9 — machine identity, live (2026-10-11 04:13–04:20Z, v0.0.50 / concierge v0.4.5)

**The platform fact that killed the hostname route:** v0.0.49's `/health`
exposes `os.hostname()` — the primary answered `"de89a38d6a10"`, and after
the v0.0.50 redeploy `"36a9069e7862"`. Inner container IDs, random per
boot, never the instance name. The identity must be resolved elsewhere.

**The design, shipped:** the concierge resolves the machine at
`/handshake` (bb JWT → the caller's registry row; the body's name is
never trusted) and returns it — the machine adopts it and re-keys every
later write. `/handoff/pull` serves a nameless wake boot under the
legacy key via the single open fire window. Postbox/snapshot AAD went
instance-free (v2) with a baked-name v1 fallback.

**Live chain:** /boot hit while the ud3b machine was mid-stop →
readiness correctly refused → the client fell back to the legacy primary
wake → **TOFU re-pin (concierge v0.4.5 measurement) → attested · v0.0.50
→ unlock with the stored secret → stream live → proof-6 session
restored** on the primary. The unlock's JWT handshake ran through the new
two-tier /handshake.

**Bug found live (the tier-mix):** the legacy fallback put waddletest2's
JWT on the PRIMARY; the new /handshake resolved the registry row
(waddle-ud3b16438-777d2b — a STOPPED sibling) for it. Identity bound to
the user, not the calling machine: the fallback path can teach the
primary a dead sibling's name. Fix (next train): the client presents
booted.name at unlock, the machine relays it at handshake, and the
concierge adopts only on registry == presented; the real fix is cattle
step 4 (delete the legacy fallback + the hardcoded primary).

**Also observed:** the reload's /boot is shadowed while the primary
answers unlocked (the client skips discovery when the enclave answers)
— step 4 removes the shadow.

## Proof 10 — the greenfield chain, end to end (2026-10-11 05:00–05:05Z, v0.0.51 / concierge v0.4.7)

No fallbacks anywhere in this chain — every leg is the cattle path:

1. **Pure discovery boot**: page load with no machine (activeEnclave
   empty — no baked URL exists anymore) → discovery → `/boot` → rebind
   `waddle-ud3b16438-777d2b`.
2. **The stale-tag gate, live**: the machine was Running at v0.0.50
   against the v0.0.51 signed release — the client had refused it
   ("Code measurement mismatch", an unrecoverable dead end pre-v0.4.7:
   /boot handed the stale machine back forever). v0.4.7's gate caught
   it and ran the treadmill dance (stop → settle → deploy --tag
   v0.0.51). First attempt hit the Stopping-race (502, recovered on
   the settled retry — redeploy now settle-waits).
3. **Readiness → attestation → TOFU re-pin** (v0.0.51's measurement) →
   lock screen.
4. **Fresh-enrollment unlock with the stored secret**: shelf restore of
   the proof-6 session (the cattle state model — a blank machine
   becomes yours by restoring your store), stream live.
5. **The fail-closed identity handshake, proven**: the machine's ring
   logs `"ok":true,"via":"jwt"` — a line that can only exist when the
   client-presented name (derived from the enclave URL) EQUALS the
   user's registry row. presented ≡ registry → session minted for the
   real machine → adopted. The proof-9 tier-mix class is structurally
   dead: no fallback path exists to carry a JWT onto the wrong machine,
   and a mismatched name is a 409, not a silent mis-binding.

Also proven tonight by absence: the primary stopped itself on the idle
gate (unlocked-then-abandoned at 04:15, reaped ~10.5 min later) and
nothing in the client ever noticed — it has no path to the primary.

## Proof 11 — v0.4.9 full lifecycle under scale-to-0 (2026-10-11)

**Setup**: concierge v0.4.9, platform concierge-only, pool empty
(`demand_ms_ago: null`), client waddletest2@betterbase.dev, live :5173.

1. **Arm** — client wake → `/boot` (discovery): `demand_ms_ago` null→19s;
   pool filled `waddle-standby-3` behind the session within one tick
   window (demand-gated fill, first live proof of the ARM side).
2. **Mint + restore** — `waddle-ud3b16438-8d6aa4` (user-shape, fresh
   mint; registry empty after the v0.4.9 restart) → attestation →
   unlock → ring: `machine restored from shelf` + `concierge handshake
   {'via':'jwt'}` (proof-10 chain reproduced under the new pool).
3. **Markers planted pre-sleep** — workspace file
   (`validation-sleepwake.txt` = `marker-1791732900-survives-sleep`) and
   a browser-profile History URL
   (`example.com/?waddle=sleepwake-1791732900`; the agent has no JS-eval,
   so the History DB IS the cookie-equivalent marker).
4. **Sleep** — client sleep button → checkpoint → machine **Stopped**
   (~10s), billing paused; stop row live (`rows:1`).
5. **Wake** — ~108s door-to-door → attestation → unlock → **both markers
   restored**: file exact-match ✅; History DB intact (163,840 bytes,
   pre-sleep mtime, grep finds the marker URL, plus DoorDash URLs from
   pre-mint sessions — the profile rides the shelf ACROSS machine
   generations). This live-proves the corrected persistence record
   (AGENTS.md 9b3ff41): shelf snapshots carry the full Chromium
   profile; attended unlocks restore it; only the tier-2 escrow arm
   strips `browser/`.
6. **Drain** (deferred check): standby-3 created ~15:31Z → TTL destroy
   ~16:31Z; by then demand is >1h stale → pool stays 0 (platform
   concierge-only). Result appended below.

**Verdict**: scale-to-0 + activity-based sleep + shelf-as-only-state all
behave as designed under v0.4.9. Approvals note: the History grep needed
an interactive bash approval mid-turn (agent stalled on the dialog until
approved — expected restricted-mode behavior, worth remembering for
unattended runs: read-only bash still prompts).

### Proof 11 addendum — audit fixes + drain (2026-10-11, later)

Full-repo four-way audit (concierge/server/client/configs) after the
"waddle"-name retirement found the class three more times, headline:
fresh mints booted-but-never-unlocked had NO reap bound at all (claim
grace rows were standby-only; the sweep's bound-skip fired before the
quiet clocks). Fixed in concierge v0.4.11 (fresh-mint grace rows,
unknown≠dead pool reaps, /wake + /assign fully deleted incl. shim +
SDK types, table.forget, tier-map truth) with the client's first-load
hydration race fixed in-tree and server env-conflation fixes staged
for the next machine release. Standby-3 was manually drained at
16:07Z (pre-TTL) rather than letting the watcher observe the TTL fire
— the TTL mechanics remain unit-proven; platform returned to
concierge-only + one sleeping user machine. Both release workflows now
refuse broken digest pins (v0.0.52's empty digest was caught pre-deploy
same day; strike-three prevention).

## Proof 12 — scheduled pushes render live in a watching client (2026-10-12, v0.0.58 / concierge v0.4.17)

The v0.0.58 headline fix, live-proven end to end on a dedicated greenfield
account (**waddlebot**, created for agent-driven testing — credentials in
`.pi/evidence/waddlebot-credentials.txt`, gitignored).

1. **Greenfield chain** — Firefox (fresh context) → sign-up → consent →
   auto-wake: first attempt died on the fresh-mint DNS window (the known
   NXDOMAIN class; retry worked, as designed). `/boot` minted
   `waddle-u750c1e69-20e2d8`; attested v0.0.58; enrolled with the
   inference key (memory-only); background tasks enabled via the warned
   dialog.
2. **Book** — "remind me in 1 minute" → reminder `8e44f714` booked for
   2026-10-12T21:54:55Z (assistant confirmed with the ID).
3. **Watch, untouched** — the tab sat open, no reload, from booking
   through fire. At 21:55:06Z the whole turn rendered by itself:
   collapsed `⏰ [scheduled: verify live push]` chip (raw prompt behind
   the details toggle) + "⏰ Reminder fired on time…" nudge. The
   transport's collectIdle → ServerRowsBridge path carried the
   server-fired rows into the running runtime — the original repro
   ("reminders never appear without a reload") closed.
4. **Evidence** — `.pi/evidence/live-push-v0.0.58-proof.png`
   (full-thread screenshot) + raw note in `wake-proofs-appendix.md`.

Two small catches on the way: a stray `python3 -m http.server 5173`
(debris from an earlier session) was shadowing vite on IPv4 — killed;
and the failed wake card promised "details below" without rendering
them — fixed in 31045a6 (detail now shows on the failed stage).

**Verdict**: v0.0.58 fully verified live — wake, TOFU, unlock, booking,
fire, and live delivery to an untouched tab.
