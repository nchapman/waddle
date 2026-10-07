# waddle

An open, fully confidential personal AI agent — a private Muse. One agent
VM per user inside a hardware-attested Tinfoil enclave; a thin, security-
critical client (attestation, keys, approvals); agent-driven browser,
private connectors, agent-curated memory.

**Read [PLAN.md](./PLAN.md) first** — it is the complete design, the closed
decisions, and the phased build plan with acceptance gates.

## Layout

| Path | What |
|---|---|
| `server/` | The server that runs in the enclave (gateway + pi harness) |
| `client/` | React client — assistant-ui over AI SDK, attestation via tinfoil SDK |
| `concierge/` | The always-on operator service — wake-only for now (scoped key, betterbase JWT auth) |
| `sdk/` | The wire contract: event log protocol shared by vm + client (+ Expo later) |
| `config/` | tinfoil-config.yml template (lives in its own public repo when deployed) |
| `PLAN.md` | The design and build plan |

## Quick start

```bash
mise install   # pinned node/pnpm/just
just setup     # install deps
just dev       # vm on :8080 (tsx watch) + client on :5173 (vite)
```

Secrets live in `.env.local` (gitignored, mode 600) — never committed.
Local is iteration speed; Tinfoil is truth (acceptance gates run attested).
