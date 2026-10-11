# Code review — uncommitted changes

> ⚠️ Verification skipped (PI_REVIEW_VERIFY=0) — findings below are **unverified**.

## 🟠 Important

### New JWT-accepting /handshake branch and k=1 /handoff/pull fallback ship with no test protection
**`concierge/src/index.ts:486`** — found by correctness, security, robustness, tests
Still valid. The diff changes /handshake from secret-only to a two-tier resolver: a verified bb JWT now calls users.rebind(id.sub) and mints a session for the resolved machine (line 485 onward), returning `instance`; and /handoff/pull gains a k=1 fallback (lines 587-600) that, when exactly one armed row has an open fire window, releases that OTHER row and teaches its name. Both are auth-relevant behavior changes with side effects (session minting for a JWT holder; serving a credential the caller did not name). No test covers either: `find concierge/src/*.test.ts` shows only auth/handoff/platform/pool/postbox/table/user-machines tests — there is no index/route test file, and grep across all test files finds `/handshake` / `/handoff/pull` referenced only in server/src (the client side), never the concierge routes. The only new concierge tests (handoff.test.ts armed()/singleOpenWindow()) exercise the store helpers in isolation and cannot reach the route logic (the JWT rebind branch, the legacyCaller gate, the ambiguity denial). A regression here — e.g. the JWT branch resolving to the wrong machine, or the fallback serving on ambiguity — would pass CI silently.

**Fix**: Add route-level tests (fastify.inject or equivalent) pinning: JWT handshake returns the rebind name and 404 when no machine; legacy-named pull is served only when exactly one window is open and 404s when zero/two windows are open.

### /handoff/pull k=1 fallback serves a fired machine's escrowed master secret to any shared-secret holder
**`concierge/src/index.ts:597`** — found by correctness, security, robustness
Still valid. Before this change, /handoff/pull only returned a credential when a wake fire existed for the exact `instance` named in the body (handoff.release(instance) → notFound otherwise), so the fire-gate bound the served row to the requesting machine. The new fallback (lines 594-601) runs whenever release(instance) fails: for a caller whose name matches neither USER_NAME_RE nor STANDBY_NAME_RE it computes handoff.singleOpenWindow() — the single armed row with an open fire window — and calls handoff.release(open), returning `{ credential: via.cred, instance: open }` regardless of the instance the caller asked for (the diff's own comment concedes this is reachable by any shared-key caller). Auth is requireSecret, i.e. the single fleet-wide CONCIERGE_TOKEN (index.ts:62) that every machine is provisioned with (STANDBY_SECRETS includes CONCIERGE_SHARED_SECRET, index.ts:85) and which server/src/concierge.ts still sends verbatim as the machine handshake bearer. The escrowed credential is the opaque bag `{ secret, schedules[], snapshot? }` (server/src/concierge.ts armHandoff doc) — the user's master secret. Consequence: any shared-secret holder can POST /handoff/pull with an allowed non-user-instance name (e.g. the baked default "waddle") during any machine's default 3-minute release window and receive that machine's master secret plus a sealed whole-machine snapshot, without knowing or naming it; the response also discloses the target's runtime-minted name. This directly contradicts the route's own guarantee ('a boot that the concierge did not successfully deploy for a schedule gets 404').

**Fix**: Bind the fallback to the caller, not just to a global open window (e.g. require a per-boot nonce/claim token minted at fire time and echoed by the boot), or restrict the servable credential set so the fallback cannot return a full master secret.

## 🟡 Suggestion

### k=1 fallback consumes the one-shot fire for any allowed shared-secret caller
**`concierge/src/index.ts:593`** — found by security, robustness
Still valid. When a pull for `instance` is notFound, the handler serves whichever single armed row currently has an open window and calls handoff.release(open) (line 597), whose success path does `firedAt.delete(instance)` (handoff.ts release, one-shot per fire). The caller is authenticated only as *some* allowed instance holding the fleet-wide shared secret; nothing verifies the caller is the fire's intended waiter. A stray/duplicate pull, or a second secret-holding machine, that carries an allowed name with no fire therefore receives the fired row's credential and permanently consumes its window; the intended boot then gets a 404 and cannot run its schedule until the next fire. The code comment acknowledges the k>1 ambiguity but leaves the k=1 mis-delivery/denial path open, and the fix for the disclosure above should also make a duplicate request non-consuming.

**Fix**: Make the fallback non-consuming on an unsuccessful/duplicate attempt (do not delete the fire until the intended boot confirms), and/or require a pull marker minted at deploy time so a duplicate request cannot burn the window the intended boot needs.

### currentInstance() is exported but unused, and its doc comment contradicts the actual AAD source
**`server/src/concierge.ts:41`** — found by correctness
The new doc block says "The AAD seal/open sites use this for legacy (v1) blob fallback only", but no seal/open site calls currentInstance() (grep shows only the definition here and imports in concierge.test.ts). server/src/postbox.ts and server/src/snapshot.ts compute the v1 fallback AAD from the module-level `process.env.WADDLE_INSTANCE ?? "waddle"` constant instead. A future edit trusting the comment could wire the adopted (post-adoption) name into the v1 AAD and break opens of blobs sealed pre-cutover — the exact failure the env-constant choice avoids.

**Fix**: Either remove the unused export and correct the comment to point at the LEGACY_INSTANCE constants, or actually route the v1 fallback through it and document why the baked name (not the adopted name) is correct.

### Legacy v1 fallback tests hardcode the baked instance name instead of the module's resolved AAD
**`server/src/postbox.test.ts:98`** — found by tests
The new v1-fallback tests seal with a literal `"waddle-postbox-v1:waddle"` (postbox.test.ts:98) and `"waddle-snapshot-v1:waddle"` (snapshot.test.ts:57), but production derives `LEGACY_INSTANCE = process.env.WADDLE_INSTANCE ?? "waddle"` (postbox.ts:44, snapshot.ts:23). The test therefore only passes when `WADDLE_INSTANCE` is unset — run the suite with that env var set and the fallback-under-test is `...:${WADDLE_INSTANCE}`, so `openAny` never matches and the test fails even though the code is correct. It also means the test asserts the implementation default rather than the behavior (a pre-cutover blob sealed under the baked name opens), so it would not catch a real mismatch between the seal-time and open-time baked name. The same coupling exists in server/src/concierge.test.ts (asserts `currentInstance() === "waddle"`).

**Fix**: Build the legacy AAD from the exported/derived value (or import the module's LEGACY_INSTANCE) rather than a hardcoded `"waddle"`, so the test pins the actual fallback candidate and is env-independent.

---

**Scope reviewed**:
- Files: concierge/src/handoff.test.ts, concierge/src/handoff.ts, concierge/src/index.ts, sdk/src/index.ts, server/src/concierge.ts, server/src/index.ts, server/src/keys.ts, server/src/postbox.test.ts, server/src/postbox.ts, server/src/snapshot.test.ts, server/src/snapshot.ts, server/src/concierge.test.ts
- ⚠️ Excluded from review: .pi/review-state.json

Continuing from a previous review (9 finding(s) carried over).

_Reviewed 12 file(s) in 281s, 1546.6k tokens ($0.074). Next: address findings, then re-run /review — still-valid findings repeat verbatim, resolved ones stay gone._