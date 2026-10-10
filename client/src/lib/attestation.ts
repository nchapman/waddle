/**
 * Attestation for the browser client: verify the enclave via SecureClient
 * before trusting it, pin the code fingerprint on first connect (TOFU),
 * and block visibly when it changes. The pinned fingerprint IS the
 * operator-code-trust story — no pinky-promises.
 */
import { SecureClient } from "tinfoil";

export interface AttestationResult {
  ok: boolean;
  client: SecureClient;
  configRepo: string;
  enclaveHost: string;
  releaseTag: string;
  releaseDigest: string;
  codeFingerprint: string;
  steps: Record<string, { status: string }>;
  /** First successful connect — pin was just written. */
  firstPin: boolean;
  /** TOFU mismatch — BLOCKED until the user approves the new fingerprint. */
  pinConflict?: { pinned: string; current: string };
}

const PIN_KEY = "waddle.attestation.pin";

interface Pin {
  configRepo: string;
  enclaveHost: string;
  codeFingerprint: string;
  releaseTag: string;
  pinnedAt: string;
}

function readPin(): Pin | null {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    return raw ? (JSON.parse(raw) as Pin) : null;
  } catch {
    return null;
  }
}

/** User explicitly approves a changed fingerprint (visible-diff flow). */
export function repin(result: AttestationResult): void {
  localStorage.setItem(
    PIN_KEY,
    JSON.stringify({
      configRepo: result.configRepo,
      enclaveHost: result.enclaveHost,
      codeFingerprint: result.codeFingerprint,
      releaseTag: result.releaseTag,
      pinnedAt: new Date().toISOString(),
    } satisfies Pin),
  );
}

export async function verifyEnclave(enclaveURL: string, configRepo: string): Promise<AttestationResult> {
  const client = new SecureClient({ enclaveURL, configRepo });
  await client.ready(); // throws if any attestation step fails

  const doc = client.getVerificationDocument();
  if (!doc || !doc.securityVerified) throw new Error("attestation did not verify");

  const base: Omit<AttestationResult, "ok" | "client" | "firstPin"> = {
    configRepo: String(doc.configRepo),
    enclaveHost: String(doc.enclaveHost),
    releaseTag: String(doc.releaseTag),
    releaseDigest: String(doc.releaseDigest),
    codeFingerprint: String(doc.codeFingerprint),
    steps: doc.steps as Record<string, { status: string }>,
  };

  const pin = readPin();
  if (!pin) {
    localStorage.setItem(
      PIN_KEY,
      JSON.stringify({
        configRepo: base.configRepo,
        enclaveHost: base.enclaveHost,
        codeFingerprint: base.codeFingerprint,
        releaseTag: base.releaseTag,
        pinnedAt: new Date().toISOString(),
      } satisfies Pin),
    );
    return { ...base, ok: true, client, firstPin: true };
  }

  if (pin.codeFingerprint !== base.codeFingerprint) {
    return {
      ...base,
      ok: false,
      client,
      firstPin: false,
      pinConflict: { pinned: pin.codeFingerprint, current: base.codeFingerprint },
    };
  }

  return { ...base, ok: true, client, firstPin: false };
}
