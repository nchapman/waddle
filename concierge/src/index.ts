/**
 * @waddle/concierge — the operator-side, always-on service.
 *
 * Speaks one verb today: wake. The client POSTs /wake with a betterbase
 * JWT; we verify it against JWKS and boot the owner's instance. Blind by
 * design: we see who woke what, never content, keys, or data. Compromise
 * costs availability and money (bounded by quotas), never confidentiality
 * — a fresh boot sits at its lock screen.
 *
 * Product phase grows this into the 3-verb controller (deploy/stop/status)
 * with presence, cron, and webhooks — same lineage, more verbs. The
 * prototype deliberately stops at wake.
 */
import fastify from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const PORT = Number(process.env.CONCIERGE_PORT ?? 8081);
const JWKS_URL = process.env.CONCIERGE_JWKS_URL ?? "";
const ISSUER = process.env.CONCIERGE_ISSUER ?? "";
const AUDIENCE = process.env.CONCIERGE_AUDIENCE ?? "waddle-concierge";
/** docker | tinfoil — config-selected backend (seam, not code fork). */
const BACKEND = process.env.CONCIERGE_BACKEND ?? "docker";

const jwks = JWKS_URL ? createRemoteJWKSet(new URL(JWKS_URL)) : null;

/** Boot the named instance. Backends are ~25 lines each by design. */
async function wake(instance: string): Promise<string> {
  if (BACKEND === "docker") {
    await exec("docker", ["start", instance]);
    return `docker:${instance} started`;
  }
  // tinfoil backend — exact create/deploy invocation settled in Phase 1
  // against a real instance (needs image digest + config repo + tag).
  throw new Error(`tinfoil backend not wired until Phase 1 (got wake:${instance})`);
}

const app = fastify({ logger: true });

app.get("/health", async () => ({ service: "waddle-concierge", version: "0.0.1", backend: BACKEND }));

app.post<{ Body: { instance?: string } }>("/wake", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token || !jwks) return reply.code(401).send({ error: "unauthorized" });

  try {
    await jwtVerify(token, jwks, { issuer: ISSUER || undefined, audience: AUDIENCE });
  } catch {
    return reply.code(401).send({ error: "invalid token" });
  }

  const { instance } = req.body ?? {};
  if (!instance) return reply.code(400).send({ error: "instance required" });

  const result = await wake(instance);
  return reply.code(202).send({ status: "waking", detail: result });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
