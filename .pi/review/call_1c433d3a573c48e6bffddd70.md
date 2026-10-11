# Code review — uncommitted changes

> ⚠️ Verification skipped (PI_REVIEW_VERIFY=0) — findings below are **unverified**.

## 🔴 Critical

### Default-empty ALLOWED plus machine default "unadopted" makes the pre-adoption shared-secret paths 403 — wake-autonomy pull and locked-boot reaper break
**`concierge/src/app.ts:560`** — found by correctness, security
Still valid; unchanged by this diff. ALLOWED is built from `CONCIERGE_ALLOWED_INSTANCES ?? ""` (app.ts:71-76) and a fresh machine's pre-adoption identity is the sentinel "unadopted" (server/src/concierge.ts:32), which matches neither USER_NAME_RE nor STANDBY_NAME_RE in allowedInstance. The /handoff/pull half is healed by the legacyCaller bypass (app.ts:655-656), but the /handshake secret branch still runs `if (!allowedInstance(instance)) return c.json({error:"instance not allowed"}, 403)` (app.ts:560) with no sentinel exemption. The locked-boot backstop in wakeBoot (server/src/app.ts) fires `handshakeConcierge(process.env.CONCIERGE_SHARED_SECRET)` with no presented name, so the body is {instance:"unadopted"} → 403 → handshakeConcierge treats 403 as definitive and returns false without retry (server/src/concierge.ts) → the `ok` callback never calls renewIdleStop(), and writeTimer short-circuits without a session. The arm-on-backstop block is therefore unreachable: an identity-less locked boot (wake row fired with no surviving credential, or a /boot mint never unlocked) cannot be stopped on the idle window and burns until the platform clocks (standby claim-grace / 24h-quiet sweep). The new concierge test in this diff (`/handshake` with instance "unadopted" → 403) pins the refusal as intent, but the server-side backstop code and its comment still depend on that handshake succeeding, so the degrade stays silent.

**Fix**: Make the two defaults agree: keep one name the pre-adoption/legacy paths can present that `allowedInstance` admits (or add an explicit sentinel allowance to the /handshake secret tier), or delete the now-unreachable locked-boot backstop handshake and re-point the comment at the platform clocks.

### /handoff/pull k=1 fallback releases the open fire window's escrowed master credential to any shared-secret holder, unbound to the intended machine
**`concierge/src/app.ts:655`** — found by correctness, security
Still present, verbatim. /handoff/pull authenticates only the fleet machine secret (app.ts:644 `requireSecret`), then `legacyCaller` (app.ts:655) is true for ANY instance string matching neither the user nor standby shape — "x", "", or the sentinel — which skips the name gate entirely (`if (!legacyCaller && !allowedInstance(instance))`, app.ts:656). The route then falls to `handoff.singleOpenWindow()` (app.ts:659) and returns that row's payload via `{ credential: via.cred, instance: open }` (app.ts:664). That payload is the user's master credential bag — handoff.ts documents it as `{ secret, schedules[], snapshot? }` (and concierge.ts's `PulledCredential` feeds `secret` straight into `lock.unlock`). CONCIERGE_SHARED_SECRET is injected into every managed machine (STANDBY_SECRETS defaults to `CONCIERGE_SHARED_SECRET,TINFOIL_API_KEY`, app.ts:99, and the same createInstance builds standbys and user machines), so any tenant's machine can poll `POST /handoff/pull {"instance":"x"}` and, whenever exactly one wake window is open (releaseWindowMs default 3 min, handoff.ts), win the one-shot release and receive another machine's master secret after its name-gate bypass. Nothing binds the release to the fired instance, contradicting the stated threat model ("Compromise costs availability and money, never confidentiality").

**Fix**: Bind the fallback to the machine: require a per-fire proof (e.g. a nonce minted into the wake deploy and echoed by the boot) or a platform-resolved instance identity before `singleOpenWindow()` is consulted, instead of serving on the shared secret alone.

### Defaulting the machine identity to "unadopted" silently breaks the locked-boot stop-backstop and the wake-boot credential pull
**`server/src/concierge.ts:32`** — found by correctness, security
Still valid. `let INSTANCE = process.env.WADDLE_INSTANCE ?? UNADOPTED` makes every boot that has not yet adopted a name send the sentinel on every concierge call (post(), concierge.ts). The wake-boot credential pull is healed (pullHandoff still posts the sentinel, but /handoff/pull's legacyCaller fallback serves the single open fire window and returns the row's real name, which adoptInstance stores). The locked-boot backstop is not: renewIdleStop() returns early when INSTANCE === UNADOPTED, and the handshake at the end of wakeBoot (server/src/app.ts, `handshakeConcierge(process.env.CONCIERGE_SHARED_SECRET)`) carries {instance:"unadopted"} → /handshake gates on allowedInstance (concierge/src/app.ts:560) → 403, which handshakeConcierge treats as definitive (no retry). No session is minted, so no stop row is ever armed for a machine nobody unlocks; it runs to the concierge's HARD_STOP sweep instead — the billing/zombie outcome the backstop exists to prevent. The only escape from the sentinel is adoptInstance() on a handshake/pull response, so any boot path whose response teaches no name stays identity-less and row-less.

**Fix**: Decide the contract explicitly: either allow the sentinel at the concierge's /handshake secret tier so the backstop can arm a row, or drop the identity-less handshake attempt and document that such boots are reaped only by the concierge's platform clocks.

## 🟠 Important

### 8 MiB body is read and parsed before authentication on /handoff/post (and other routes), so the cap is an unauthenticated buffering surface
**`concierge/src/app.ts:683`** — found by correctness
The comment above this route justifies the raise with 'a raise is an unauthenticated buffering surface', but the code does the opposite of what that implies: `readJson<PostboxPostRequest>(c, 8 * 1024 * 1024)` drains and parses up to 8 MiB at line 683, and only then does line 689 call `requireSession`. Nothing before the read checks the Authorization header, so any unauthenticated client can force the concierge to buffer/parse 8 MiB per connection (the default 1 MiB routes /handshake line 533 and /handoff/pull line 641 have the same ordering). The 8 MiB cap bounds a single request but not concurrent ones.

**Fix**: Authenticate from the request header first (reject 401 before touching the body), or read the instance from a query/route parameter so the tier check can run before the streamed body is buffered.

### onClose unconditionally wipes the live socket's sink and denies its pending approvals
**`server/src/app.ts:812`** — found by correctness
onClose (line 807) runs applyQuietSink() (812) and denyAllPending() (813) unconditionally, without checking that no socket remains or that the closing socket was ever authenticated. A locked /ws connection is closed 4401 in onOpen (line 746) before `sockets.add`, yet its onClose still fires: sockets.delete is a no-op but the side effects run. denyAllPending (approvals.ts:118) resolves every pending approval as denied and emits approval:false; applyQuietSink replaces the connected client's sink, so deltas/tools/finals stop streaming to it until it reconnects. The same ordering bug hits a reconnect race (new socket's sink set in onOpen, then the stale socket's onClose overwrites it). fireSchedule (line 248) guards this with `if (sockets.size === 0) applyQuietSink()`; onClose does not.

**Fix**: Guard the quiet-sink swap and denyAllPending on `sockets.size === 0` after deleting this socket, and skip the side effects for sockets that were never authenticated.

## 🟡 Suggestion

### /health demand_ms_ago serializes as null when demand was never marked
**`concierge/src/app.ts:365`** — found by correctness
A concierge that has seen no /boot since boot (scale-to-0 cold start) returns `demand_ms_ago: null` on the public /health route: the intended sentinel is Infinity, which JSON cannot represent and silently becomes null. The declared type (`demandMsAgo(): number`) also lies to callers — server-side or client-side comparisons (`demand_ms_ago > ttl_ms`) against null are false/NaN-ish rather than "never", which is exactly the case the field exists to expose. concierge/src/app.test.ts:60-65 only covers the pool-off branch ({size:0}), so the pool-on shape is untested.

**Fix**: Serialize the never-marked case explicitly (e.g. `lastDemandAt === null ? null : ms` with the field typed `number | null`, or `-1`), and pin it in the pool/health test that currently only asserts the numeric case.

### Orphan janitor can never destroy the class it documents — adopt() runs last and spares every user-pattern name
**`concierge/src/app.ts:840`** — found by correctness
`users.adopt([...statuses.keys()])` runs immediately before this loop in the same synchronous block and adds every platform name matching the user pattern to `known()`. `spared` is then `new Set([...users.known(), ...ALLOWED])`, so for every user-shaped name the condition `USER_NAME_RE.test(name) && !spared.has(name)` is false. The only names that can reach the destroy call are ones adopt skipped — i.e. names in the `retired` tombstone set. A stray whose destroy failed, or a name forgotten via `users.forget`, is re-adopted on the next scan and spared indefinitely (until the separate HARD_STOP_MS backstop sweep). The comment's claim that such a machine 'ends up here' is therefore unreachable in practice.

**Fix**: Either drop the janitor and document that the hard-stop sweep owns stray user machines, or compute the spare set independently of the just-run adopt (e.g. `boundNames() ∪ ALLOWED` plus a separate adopted-earlier cutoff) so the janitor has a reachable condition.

### Unauthenticated /probe discloses container capability/runtime fingerprint
**`server/src/app.ts:287`** — found by correctness, security
Still valid (code unchanged; insertion of the /ws onMessage guard shifted later lines only). /probe has no requireSession gate (unlike /debug/log:463-464, /state:468-469, /session:480-481) and is reachable on the 0.0.0.0 listener before any unlock. It returns uid, the effective capability mask (capEff), Seccomp mode, NoNewPrivs, the cgroup line from /proc/mounts, dataDirWritable and the Node version — a free map of the sandbox posture for an attacker probing an unauthenticated surface, useful for planning an escape or a DoS against the enclave.

**Fix**: Gate /probe behind requireSession like the other debug endpoints, or drop the capability/seccomp/cgroup fields from the unauthenticated response.

### The armed wake credential is never cleared on a user unlock, contradicting the documented contract
**`server/src/app.ts:1013`** — found by correctness, security
Still valid. server/src/wakeboot.ts documents the credential file as "cleared on first user unlock", and clearWakeCredential is imported into app.ts, but grep over app.ts shows the only call site is wakeBoot's failure catch (now server/src/app.ts:1017; the import is line 31). The /unlock handler (plain attended path and the autonomous-takeover path) never calls it, so after a real user unlock the plaintext master secret plus schedule rows written by rearmEscrow (app.ts:711, dev file arm) remain readable in DATA_DIR/wake-credential.json — a master secret at rest that the documented invariant says has been invalidated, and that a later locked boot on the same volume re-reads (the volume is normally fresh, which is what bounds the exposure).

**Fix**: Call `clearWakeCredential()` once in the successful /unlock path (after the takeover flag is committed), or correct the wakeboot.ts doc if leaving the file in place is intended.

### Default-identity assertion pins the exact sentinel and is coupled to WADDLE_INSTANCE, without covering the fail-closed contract
**`server/src/concierge.test.ts:22`** — found by correctness
Still present: the first test asserts `currentInstance() === "unadopted"` (server/src/concierge.test.ts:22) while the module initializes from `process.env.WADDLE_INSTANCE ?? UNADOPTED` (server/src/concierge.ts:32). The assertion therefore depends on the ambient environment not setting WADDLE_INSTANCE (the prod/dev compose distinction this change cares about), and it pins the sentinel string rather than the contract that matters — that the sentinel is refused by the concierge's gates so no session is minted.

**Fix**: Delete and re-set `process.env.WADDLE_INSTANCE` explicitly in the harness, and assert the fail-closed behavior (sentinel → no session, no adoption) rather than the literal string.

### The prod entry's /ws upgrade wiring is exercised by no test — a wrong option silently 500s the only event channel
**`server/src/index.ts:24`** — found by security
`websocket: { server: new WebSocketServer({ noServer: true }) }` (index.ts:24) is the sole wiring for /ws, and every test in the repo drives the app in-process via app.request() (server/src/app.test.ts, app-concierge.test.ts, which this diff adds), never reaching the node adapter's upgrade handling. The adapter's contract makes this risky: createAdaptorServer throws unless options.websocket.server.options.noServer === true, and upgradeWebSocket returns `new Response(null, { status: 500 })` when no ws server was attached — so an option change (or a move of the /ws route to a different path) passes the whole suite and fails only in production, where the client's stream, approvals and sleep notices all ride that socket. The new onMessage authorization guard (server/src/app.ts) also lives behind this untested upgrade path.

**Fix**: Add one smoke test that boots the real adapter (serve/createAdaptorServer on port 0 with the same options) and performs a real WebSocket handshake against /ws with a session token, asserting the upgrade succeeds, hello + replay frames arrive, and an unauthenticated upgrade is closed.

---

**Scope reviewed**:
- Files: concierge/package.json, concierge/src/index.ts, server/package.json, server/src/index.ts, concierge/src/app.test.ts, concierge/src/app.ts, server/src/app-concierge.test.ts, server/src/app.test.ts, server/src/app.ts
- 4 chunks — chunk 1: correctness, security; chunk 2: correctness, security; chunk 3: correctness, security; chunk 4: correctness, security
- ⚠️ Excluded from review: .pi/review-state.json, pnpm-lock.yaml

Continuing from a previous review (12 finding(s) carried over).

_Reviewed 9 file(s) in 1046s, 9470.0k tokens ($0.356). Next: address findings, then re-run /review — still-valid findings repeat verbatim, resolved ones stay gone._