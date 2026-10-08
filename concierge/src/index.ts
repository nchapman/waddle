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
import cors from "@fastify/cors";
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
  // tinfoil backend — deploy boots a stopped instance with its current
  // measured config. Needs the CLI on PATH + TINFOIL_ADMIN_KEY in env.
  try {
    const { stdout } = await exec("tinfoil", ["container", "deploy", instance], {
      timeout: 120_000,
    });
    return stdout.trim().split("\n").slice(-3).join(" | ");
  } catch (e) {
    // Zombie state: the agent idle-slept (process exit) but the instance is
    // still Running — deploy 409s. A same-tag update redeploys the container.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("cannot deploy a running instance")) {
      const { stdout } = await exec(
        "tinfoil",
        ["container", "update", instance, "--tag", process.env.CONCIERGE_WAKE_TAG ?? "v0.0.13", "--yes"],
        { timeout: 180_000 },
      );
      return "(zombie redeploy) " + stdout.trim().split("\n").slice(-2).join(" | ");
    }
    throw e;
  }
}


/** Stop the named instance (billing stops with it). The agent exits its own
 *  process at sleep; the client relays the platform-level stop to us. */
async function rest(instance: string): Promise<string> {
  if (BACKEND === "docker") {
    await exec("docker", ["stop", instance]);
    return `docker:${instance} stopped`;
  }
  const { stdout } = await exec("tinfoil", ["container", "stop", instance], { timeout: 120_000 });
  return stdout.trim().split("\n").slice(-3).join(" | ");
}

const app = fastify({ logger: true });

// The browser client calls us cross-origin (dev: Vite on :5173).
await app.register(cors, { origin: (process.env.CONCIERGE_ALLOWED_ORIGINS ?? "http://localhost:5173").split(",") });

app.get("/health", async () => ({ service: "waddle-concierge", version: "0.0.1", backend: BACKEND }));

app.post<{ Body: { instance?: string } }>("/wake", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  // Prototype auth: shared-secret stand-in until betterbase JWTs land (the
  // seam stays — swap this block for jwtVerify when accounts integrate).
  const sharedSecret = process.env.CONCIERGE_TOKEN;
  if (sharedSecret) {
    if (token !== sharedSecret) return reply.code(401).send({ error: "unauthorized" });
  } else if (jwks) {
    try {
      await jwtVerify(token!, jwks, { issuer: ISSUER || undefined, audience: AUDIENCE });
    } catch {
      return reply.code(401).send({ error: "invalid token" });
    }
  } else {
    return reply.code(401).send({ error: "concierge auth not configured" });
  }

  const { instance } = req.body ?? {};
  if (!instance) return reply.code(400).send({ error: "instance required" });

  const result = await wake(instance);
  return reply.code(202).send({ status: "waking", detail: result });
});


app.post<{ Body: { instance?: string } }>("/stop", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const sharedSecret = process.env.CONCIERGE_TOKEN;
  if (!sharedSecret || token !== sharedSecret) return reply.code(401).send({ error: "unauthorized" });
  const { instance } = req.body ?? {};
  if (!instance) return reply.code(400).send({ error: "instance required" });
  try {
    const result = await rest(instance);
    return reply.code(202).send({ status: "asleep", detail: result });
  } catch (e) {
    return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
  }
});

await app.listen({ port: PORT, host: "0.0.0.0" });
