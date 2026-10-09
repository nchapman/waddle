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

## v0.0.28 — zstd slots (2026-10-09)

Pack: plain tar | zstd -3 (explicit CLI, never tar's --zstd — macOS
bsdtar accepts the flag without libzstd and emits broken streams).
Restore: magic-sniffed (zstd 28 b5 2f fd / gzip 1f 8b), gzip decodes
in-process via node:zlib, untar from a temp file (bsdtar can't pipe
zstd via stdin). 46.7 KiB vs 54.7 KiB gzip for the same machine.
Proof: gen 17 pushed as zstd, wipe → unlock → restore gen 17, cookie
`creation_utc 13435961005614428` byte-identical; gzip-legacy restore
covered by test. Live smoke v0.0.28 chat round-trip.

---

## LIVE PROD PROOF — v0.0.32 (2026-10-09)

The full cycle on the live tinfoil enclave
(`waddle.ddg-waddle.containers.tinfoil.dev`) against PROD betterbase
(`accounts.betterbase.dev` / `sync.betterbase.dev`), account
`waddletest1@betterbase.dev` (space `879bff47-ea1c-577d-9ac8-1cb6f289b724`):

1. Unlock (stored secret) → grant armed (per-space anchor
   `b47a6b6c-cdde-556f-a8e6-18d1055a75db`, derived, not the old fixed id)
2. Marker message sent; agent replied + wrote a file
3. Sleep → final shelf push (zstd slot + manifest under `waddle-shelf-v1:` ids)
4. **Destroy**: `tinfoil container stop && deploy` — fresh volume, zero history
5. Unlock → **`machine restored from shelf gen=8 events=26`** (from
   `/debug/log`, the session-gated ring buffer shipped in v0.0.31) —
   marker message, replies, tool calls all present in `/state`

Bugs this flushed out (each verified fixed on the live enclave):

- **Anchor RecordIdCollision** (multi-user killer): sync record ids are
  global per deployment; the old fixed anchor id `4f6a8c0e…` got a
  *permanent* `bad_request` push rejection for every account after the
  first (`push_error_result` maps `RecordIdCollision` → bad_request).
  Fixed by deriving the anchor uuid from the space id
  (`machineAnchorId()`, RFC 4122 v5 shape). Commit `eeb10ed`.
- **EROFS on tinfoil**: the enclave mounts `/tmp` read-only; restore
  staged its slot at `os.tmpdir()` and died instantly — live machines
  silently booted fresh while docker/compose restored fine (writable
  `/tmp`). Fixed by staging under `DATA_DIR/tmp`. Commit `9a61ce8`.
  Found via `/debug/log` (tinfoil exposes no logs/exec — the ring buffer
  is the observability bridge; keep it).
- **Registry tag cache**: tinfoil's node cached v0.0.30's first
  arm64-only manifest for the tag; later amd64 pushes under the same tag
  still failed with `no matching manifest for linux/amd64/v3`. Building
  with `--platform linux/amd64` *and* pushing under a fresh tag per
  release dodges the cache.

Local parity note: the same image run via compose restores fine against
prod (gen 4/16 events seen during debugging) — compose can't reproduce
the EROFS class of bug; only the live enclave can.

## MULTI-USER PROOF — v0.0.32 live (2026-10-09, immediately after)

`waddletest2@betterbase.dev` (space `b7d64543-fe27-5774-a174-a85aeee93a8f`)
on the same enclave, same browser, **fresh unlock secret**:

1. Signed out waddletest1, signed in waddletest2 via prod OAuth (PKCE,
   consent "Authorize waddle") — own space, own anchor
   `1c3bf4d6-3b1a-5ee6-a536-1cb68e5e2316` (per-space derivation working)
2. Enrolled a new secret (`generate secret & unlock`) — fresh machine,
   **empty greeting**: no trace of waddletest1's history or shelf
3. Initial backup pushed (anchor synced server-side on first try — the
   RecordIdCollision class is gone)
4. Marker `SHELF-PROOF-D` sent → sleep → **destroy** (stop + deploy,
   fresh volume) → unlock → `machine restored from shelf gen=1 events=3`,
   marker D back in the UI

Cross-visibility: none — spaces, anchors, secrets, shelves are fully
disjoint per user. The old fixed anchor id would have permanently
rejected this second account (`bad_request` / RecordIdCollision).
