# Code review — uncommitted changes

> ⚠️ Verification skipped (PI_REVIEW_VERIFY=0) — findings below are **unverified**.

## 🟠 Important

### Master unlock secret is escrowed to the concierge, letting it decrypt all user state
**`server/src/index.ts:563`** — found by correctness, robustness
The sleep-gate re-arm calls `armHandoff({ secret: armSecret, schedules, snapshot }, bearer, ...)` where `armSecret` is the raw master unlock secret (set at unlock line 293 `armSecret = secret`, inherited on autonomous boot line 875 `armSecret = cred.secret`), not the previous schedule-scoped subkey. The same baggage carries the sealed snapshot, which is sealed under HKDF(master,"waddle/snapshot") (snapshot.ts), and the master also derives the verifier/log/postbox key domains. So the key travels with the ciphertext it protects: anyone with access to the concierge's memory (its operators, or an attacker who compromises it) can decrypt the whole machine (browser logins, pi transcript, sealed log) and derive every other key. This converts the concierge from a ciphertext-holder into a full-master holder, contradicting the consent dialog's "Operators still cannot read your data" claim.

**Fix**: Keep as a tracked security finding: either escrow a snapshot-scoped subkey (as handoff.ts documents) instead of the master, or explicitly record in PLAN/AGENTS that full-delegation embeds the master and that concierge capture == master compromise.

### Master root secret written in cleartext to DATA_DIR on every sleep, contradicting the code's stated invariant
**`server/src/index.ts:573`** — found by correctness, robustness
The dev file arm does `armWakeCredential({ secret: armSecret, schedules, snapshot, inferenceKey })`; `armSecret` is the raw 64-byte master, and `armWakeCredential` (wakeboot.ts) JSON.stringifies the whole object to `DATA_DIR/wake-credential.json` at mode 0o600. That secret is the root of every derived key (verifier, session, snapshot, postbox, log). The invariant comment above `armSecret` still asserts the value is memory-only / "never in DATA_DIR". The write is gated only by `!process.env.TINFOIL_API_KEY && autonomyEnabled()`; any deployment missing TINFOIL_API_KEY, or dev with a mounted persistent volume, persists the master at rest where any process or backup that can read DATA_DIR recovers it.

**Fix**: Gate the dev file arm on an explicit dev flag (e.g. NODE_ENV !== 'production' && WADDLE_DEV_ARM=1) rather than the absence of TINFOIL_API_KEY, or drop it; if kept, make the invariant text say it is dev-only-by-env.

### Warned delegation opt-in is client-side only — any authenticated session can enable full delegation
**`server/src/index.ts:728`** — found by correctness, robustness
The WS `preference` intent calls `setPreferences({ background })` straight off the wire from any session that passes the session-bearer check (the same is true of the `/unlock` `background` field). `background=true` is what makes the next sleep gate escrow the master secret and a sealed snapshot to the concierge. The only thing between tier 0 and tier 1 is `hasAcceptedWarning()` reading localStorage in the client; the server has no notion the warning was ever shown (the in-code comment itself concedes it is "UX honesty, not the security boundary"). A single WebSocket message `{type:"preference",background:true}` — from script injected into the client origin, a lifted session token, or a buggy client — silently crosses the boundary without the user ever seeing the warning.

**Fix**: Either confirm at the server that the preference transition is accompanied by the interactive-unlock proof, or document the escalation as accepted residual and note it in the session-token threat model.

## 🟡 Suggestion

### Fresh-device preference adoption marks the warning accepted without ever showing it, untested
**`client/src/App.tsx:473`** — found by correctness, robustness, tests
Still valid — this diff does not touch the file and the branch remains unprotected. In the unlock flow (client/src/App.tsx:472-476) `if (getBackgroundPref() === null && typeof unlocked.background === "boolean") { if (unlocked.background) acceptWarning(); ... }`: on a device that has never chosen, a machine whose snapshot reports `background=true` calls `acceptWarning()`, which sets BOTH the ACCEPTED_KEY and PREF_KEY (client/src/lib/background.ts:34), so the one-time delegation warning is recorded as shown-and-accepted without BackgroundDialog ever rendering. The only client tests are client/src/lib/background.test.ts and client/src/lib/bb-grant.test.ts (find shows no App/component test); background.test.ts asserts only the primitives (getBackgroundPref/setBackgroundPref/hasAcceptedWarning/acceptWarning), so this adoption branch, the toggleBackground warn-gate, and the server `preference` echo path are all unprotected — a regression could enable tier-1 delegation (master secret escrowed to the concierge) on a fresh device with no warning and no failing test.

**Fix**: Surface a one-time confirmation on a device that has never recorded acceptance (or assert in a test that the adoption path is intentional and guarded).

### schedule_create's new delegation gate has no test asserting the refusal path
**`server/src/agent.ts:263`** — found by correctness, robustness, tests
Still valid — the gate at server/src/agent.ts:263 (`if (!backgroundTasksEnabled()) { return {content:[{type:"text", text:"Background tasks are disabled …"}]} }`) is unchanged and untested. There is no agent test file at all (find shows approvals/archive/bb-backup/input-map/log/memory/postbox/preferences/schedules/snapshot/state — no agent.test.ts), and schedules.test.ts exercises the schedule store directly, so nothing asserts that the refusal fires when the preference is off, nor that creation still succeeds when it is on. A regression that drops or inverts the gate would be invisible: schedules would silently be creatable at tier 0, exactly the delegation boundary this change is built around.

**Fix**: Add a unit test that stubs backgroundTasksEnabled() false and asserts no schedule is created and the refusal text is returned, plus the enabled case creating one.

---

**Scope reviewed**:
- Files: AGENTS.md, PLAN.md, concierge/src/index.ts, config/concierge-tinfoil-config.yml, config/tinfoil-config.yml
- ⚠️ Excluded from review: .pi/evidence/wake/wake-proofs.md

Continuing from a previous review (6 finding(s) carried over).

_Reviewed 5 file(s) in 428s, 1368.3k tokens ($0.094). Next: address findings, then re-run /review — still-valid findings repeat verbatim, resolved ones stay gone._