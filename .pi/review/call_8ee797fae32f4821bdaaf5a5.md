# Code review — uncommitted changes

> ⚠️ Verification skipped (PI_REVIEW_VERIFY=0) — findings below are **unverified**.

## 🟠 Important

### New JWT-accepting /handshake branch and k=1 /handoff/pull fallback ship with no test protection
**`concierge/src/index.ts:489`** — found by correctness, robustness
The JWT tier of /handshake (index.ts:502-513: users.rebind(sub) → presented-mismatch 409 → table.mintSession(resolved)) and the k=1 fallback in /handoff/pull (index.ts:615-616) are new security-relevant branches. There is no index.test.ts anywhere under concierge/src (only auth/handoff/platform/pool/postbox/table/user-machines tests), and handoff.test.ts only exercises singleOpenWindow at the store level, never the route wiring. A regression in the presented_instance === resolved check or in the legacyCaller gate would ship silently.

**Fix**: Add route-level tests (inject Fastify) covering: JWT match, JWT mismatch → 409, JWT with no registry row → 404, and the /handoff/pull fallback granting only for a name in no dynamic namespace with exactly one open window.

### /handoff/pull k=1 fallback serves a fired machine's escrowed master secret to any shared-secret holder
**`concierge/src/index.ts:615`** — found by correctness, security, robustness
Verified in the working tree: /handoff/pull (index.ts:601) gates only on requireSecret (the fleet-wide CONCIERGE_TOKEN / SHARED_SECRET, line 278). After requireSecret and allowedInstance, lines 615-621 compute `legacyCaller = !USER_NAME_RE.test(instance) && !STANDBY_NAME_RE.test(instance)` — i.e. any caller that passes an ALLOWED name such as the default "waddle" — and, when exactly one fire window is open, do `handoff.release(open)` and return `{ credential: via.cred, instance: open }`. handoff.ts:112-128 returns the whole opaque payload (the machine's master secret plus schedules and sealed snapshot) once a markWakeFired has occurred within the ~3-minute release window. So any holder of the shared secret can, during a schedule-boot window, pull another machine's master secret — the crown-jewel credential the escrow exists to protect — without knowing or matching the fired instance's name. This is the k=1 fallback path, not covered by exact-key semantics.

**Fix**: Bind the fallback to something the genuine boot can prove (e.g. restrict to the fire's own deploy/boot provenance, or require the puller to present the fired instance name once the platform exposes instance identity), and document the residual k=1 exposure explicitly.

### Boot-failure test now passes vacuously — the demand gate stops it ever booting
**`concierge/src/pool.test.ts:260`** — found by tests
`it("a failed boot is forgotten immediately")` creates the pool but never calls `pool.markDemand()`, then ticks once and asserts `tracked().length === 0`. With the new fill gate `if (cfg.size > 0 && warmthArmed && ...)` and `warmthArmed = lastDemandAt !== null && ...`, `lastDemandAt` is still null here, so the fill block is skipped and `deps.boot` is never invoked. The assertion `tracked().length === 0` is therefore trivially true and no longer exercises the code path it was written to protect (a `boot()` rejection must delete the just-inserted `booting` entry and log `boot failed`). This test was not among the ones updated with `markDemand()` in this diff, so the scale-to-0 change silently removed its coverage.

**Fix**: Call `pool.markDemand()` before the tick (as the other fill-exercising tests now do) so `boot` is actually attempted and the failure/cleanup path is verified; optionally assert `h.booted.length === 0` and that `tracked()` is empty after the rejected boot.

### Existing 'tick keeps warm stock whose tag matches expectedTag' test now passes vacuously — no markDemand()
**`concierge/src/pool.test.ts:315`** — found by robustness, tests
`it("tick keeps warm stock whose tag matches expectedTag")` builds a pool with `expectedTag: "v1.0.0"` and `nextName`, ticks three times, and asserts `destroyed.length === 0`. It never calls `pool.markDemand()`, so under the new demand gate the pool never boots a standby, `assign`/warm-stock never exists, and `destroyed` is empty for the trivial reason that nothing was ever created. The test therefore no longer demonstrates that tag-matching warm stock survives the stale-tag reap (which is the behavior it was added to protect). Note the sibling test just above (`tick destroys warm stock on a stale tag`) was correctly updated with `pool.markDemand()` at line 308, so this asymmetry is easy to fix.

**Fix**: Add pool.markDemand() before the ticks in this test (mirroring the stale-tag test) and assert that a standby was actually booted/warm, so the zero-destroy assertion is meaningful.

## 🟡 Suggestion

### New first-load discovery branch in run() is untested — App.tsx has no test file
**`client/src/App.tsx:214`** — found by correctness, robustness
The discovery-first retry branch added to run() (discoveryTriedRef guard, the !DEV && !discoveryTriedRef.current one-retry path, AbortSignal.timeout(2500) /health probe) has no test; find shows only client/src/App.tsx, no App.test.*. The retry/no-retry decisions and the timeout path are exactly the kind of branch that silently regresses.

**Fix**: Add a test exercising first load with no stored machine: one discovery attempt, error screen on a second failure, and no repeating discovery loop.

### /health demand_ms_ago serializes as null when demand was never marked
**`concierge/src/index.ts:303`** — found by correctness, robustness
pool.demandMsAgo() is documented (pool.ts) and unit-tested to return Infinity when the pool has never been used, and it returns deps.now() - lastDemandAt otherwise. /health returns it in JSON, and JSON serialization of Infinity is null, so a consumer of /health receives demand_ms_ago: null rather than a numeric idle time — the field's type is effectively number|null despite the interface declaring number.

**Fix**: Return null explicitly (or a sentinel like -1) from the route when demandMsAgo() is Infinity, and type the field accordingly.

---

**Scope reviewed**:
- Files: concierge/src/index.ts, concierge/src/pool.test.ts, concierge/src/pool.ts

Continuing from a previous review (6 finding(s) carried over).

_Reviewed 3 file(s) in 102s, 529.7k tokens ($0.043). Next: address findings, then re-run /review — still-valid findings repeat verbatim, resolved ones stay gone._