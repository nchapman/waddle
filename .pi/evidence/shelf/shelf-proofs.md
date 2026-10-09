# The Shelf — whole-machine backup — proofs (v0.0.25 → v0.0.27)

> v0.0.27 update: audited slot contents by decrypting them (the unlock
> secret derives the DEK-unwrap key; blobs + wrapped DEKs live in the dev
> sync's postgres/fs). A 34 MiB hands-era slot vs a 295 KiB fresh one:
> 96% of the big slot was Chromium component payload (TTS wasm 22.8 MiB,
> component_crx_cache 38 MiB, omnibox model 7.7 MiB, metrics 4 MiB, CRL
> sets…) — zero user state. The archive now excludes component packages,
> shader caches, predictor/telemetry DBs, blob storage, tab-session
> scratch; a lived-in machine shelves at ~54 KiB. The empty-machine guard
> gates on the sealed event log (not tarball size, which the excludes
> pushed under the old 64 KiB floor) and now also stops a failed-restore
> boot with gen -1 from clobbering latest. Proof: wipe → unlock restores
> gen 14, cookie byte-identical, no component dirs in the restored tree.

> v0.0.26 update: betterbase sync `bf55fe7` made the files API honest
> (409 on conflicting PUT, byte-identical retries idempotent, DELETE +
> tombstones, quotas, body limit raised — GH #8/#9). The shelf now heals
> on 409 by resyncing its generation counter, prunes heavy slots to a
> 3-generation window through the DELETE route (manifests stay as an
> append-only discovery log), doubles over that log to the high-water
> generation, and restores walk down past pruned slots. Proven on the
> dev stack running their code: restore gen 8 from a pruned shelf onto a
> wiped volume, cookie jar byte-identical (`creation_utc` match), prune
> tombstoning exactly the six slots behind the window.

Architecture: the enclave is the source of truth for its own backups. It
tars its entire working directory (sealed log, pi sessions, workspace,
Chromium profile — logins ride with it), seals it under a fresh DEK
wrapped with `HKDF(unlock secret, "bb-dek")`, and pushes it to the
user's betterbase personal space over its own egress. The client is a
pipe: unlock + a one-shot grant of pure credentials (token, spaceId,
epoch, anchorId). No epoch key leaves the browser; no betterbase
credential rests unencrypted anywhere.

All proofs on the final build (image `4833fa0ad8c3`, tests 29/29,
check green), compose stack against the dev betterbase sync.

## Push path (enclave-side, end to end)

- Grant armed at unlock (files-scoped token; `bb` in the unlock body
  verified by intercepting the request: `{secret, nonce, inferenceKey,
  bb:{epoch:1, endpoint:…5379/api/v1}}`).
- Initial push: `initial backup pushed:true` — manifest (172 B) +
  slot (278 B fresh machine) landed in the sync `files` table
  (cursor 67/68), `wrapped_dek` exactly 44 bytes with the epoch
  prefix (`readUInt32BE(0) === epoch`).
- Real machine: sleep → `stopBrowser()` flushes the Chromium cookie
  jar (Cookies db mtime moves to exit time) → final checkpoint
  `final backup done pushed:true` — 33,422,984-byte slot + manifest,
  then the process exits. Auto-shutdown can no longer lose state.

## Restore path (fresh volume, ground truth)

`docker compose down -v` (wiped named volume — the ephemeral-disk
stand-in) → `up` → unlock:

- `machine restored from shelf {gen:4, events:8}` — restore happens
  inside the unlock, before the response returns; the client seeds
  from the restored log like any live boot (`seeded: true`, composer
  live).
- Cookie ground truth: `browser/Default/Cookies` row for the probe
  page — `creation_utc 13435961005614428` identical before wipe and
  after restore (`MATCH`). The exact cookie object survived:
  live browser → graceful stop/flush → tar → seal → DEK-wrap → PUT →
  volume wipe → HEAD-walk discovery → GET → unseal → staged untar →
  fresh browser.
- Agent-level witness (restored machine's own browser): pre-wipe
  conversation seeded (`cookie set now: probe-1791485670331`), and the
  restored agent reports `COOKIE PRESENT: probe-1791485670331`.

## Bugs found by the proofs (all fixed in 4833fa0ad8c3)

1. Betterbase files are immutable (`PutMode::Create`); a repeat PUT
   to the same id returns success while keeping the old bytes — our
   fixed slot id meant every "successful" push after the first was a
   silent no-op. Fixed with generational slots: deterministic
   manifest ids per generation, nonce-randomized slot ids, grant
   arming probes the shelf's high-water generation, restore walks
   generations to the latest. Filed upstream as
   BetterbaseHQ/betterbase#9.
2. Sync API body limit: axum's default 2 MiB `DefaultBodyLimit`
   rejected the 33 MB upload (413) before the handler's own 100 MiB
   check ran. Patched locally in betterbase-dev (route-scoped
   `DefaultBodyLimit::max(MAX_FILE_SIZE)`); filed as #8.
3. Sleep raced Chromium's lazy persistence: the final checkpoint
   tarred an unflushed cookie jar (fingerprint gate even skipped the
   push). Fixed with `stopBrowser()` (CDP `Browser.close`, bounded)
   before the final push.
4. Fingerprint excludes never applied in the walk (`./`-anchored
   patterns vs `/`-rooted walk paths) — regenerable cache churn
   moved the change gate and a restored tree could never
   fingerprint-match. Walk now emits `./`-rooted paths; test asserts
   cache churn leaves the fingerprint unchanged.
5. Restore wiped DATA_DIR before extracting — a failed untar would
   destroy the machine. Extraction now stages inside the tree and
   swaps only after a proven-good extract (same filesystem).
6. A failed restore could shelf an empty machine as the newest
   generation, starving the next cold boot. Guard: a near-empty tree
   (gzip < 64 KiB) never clobbers a populated shelf; recovery is
   shelving a good generation on top (demonstrated: poisoned gen 3
   → good gen 4 → wiped boot restored gen 4 + cookie).
7. Unlock could race the client's betterbase session hydration and
   silently shelf nothing all session. The client now waits (≤3 s)
   for the session to settle before building the grant.
8. Unsealed debug `GET /archive` served the whole machine (cookies,
  transcripts) to any session bearer — deleted. Machine bytes only
  travel sealed under the DEK.

## Ceremony

- v0.0.25 tagged + pushed: `ghcr.io/nchapman/waddle@sha256:4833fa0a…`
- waddle-config pinned, workflows green (Release + Publish v0.0.25).
- Live enclave updated (`Expected source: …@v0.0.25`, verified),
  TOFU re-pinned at :5174, live smoke: unlock + chat round-trip ✓.

## Known limits (documented, not blocking)

- Old generations are never pruned (no DELETE route in the files
  API — see #9). Change-gated pushes bound the growth; a few dozen
  generations/day worst case at ~30 MB each.
- The grant's bearer token is one-shot from unlock (no refresh
  enclave-side); a session that outlives the token's lifetime stops
  pushing (warned in logs) until the next unlock. Idle sleep (1 h)
  bounds the exposure.
- Live (tinfoil cloud) shelf is dormant until the hosted sync runs
  the #8 fix and the live client is signed in with a files-scoped
  session; dev stack is fully proven above.

## v0.0.27 slot audit (2026-10-09)

Decrypted slot contents (wrapped DEK from sync postgres, DEK unwrap via
HKDF(unlock secret, "bb-dek"), body AES-256-GCM, AAD `bb-file:${id}`):

| slot | gzip | raw | what it was |
|---|---|---|---|
| hands-era (b9a1e4d2) | 33.2 MiB | ~82 MiB | component_crx_cache 38 MiB, WasmTtsEngine 22.8 MiB, OnDeviceHeadSuggestModel 7.7 MiB, BrowserMetrics 4 MiB, ActorSafetyLists 2.6 MiB, hyphen-data 1.7 MiB, ZxcvbnData 1.6 MiB, CertificateRevocation 1.3 MiB; **user state ~3 MiB** |
| fresh-era (dd60282d) | 295 KiB | 2.8 MiB | Dawn shader caches 1 MiB, Dictionaries 441 KiB, History 160 KiB, Web Data 154 KiB, logins/autofill, log+sessions |
| surgical (e3fd10a2) | 54 KiB | ~0.9 MiB | History, Web Data, logins, Trust Tokens, nssdb, sessions 15 KiB, log 7 KiB — state only |

Post-surgery: push → prune (keeps 3 gens) → wipe → restore gen 14,
cookie `creation_utc 13435961005614428` byte-identical, restored tree
contains zero component dirs.
