/**
 * Key derivation + AEAD helpers. Everything user-visible is derived from
 * the 64-byte client secret; nothing derived is ever written plaintext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/** Constant domain-separation nonce for long-lived derivations. */
const ROOT_NONCE = Buffer.from("waddle-root-v1");

export function derive(secret: Buffer, label: string, nonce: Buffer = ROOT_NONCE, len = 32): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, nonce, `waddle/${label}`, len));
}

/** AES-256-GCM seal → iv || ciphertext || tag. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Throws if key or AAD is wrong — the unlock check rides on this. */
export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
}

/** Open with AAD fallbacks (v2 constant first, legacy v1 instance-bound):
 *  throws the LAST error when every candidate fails. */
export function openAny(key: Buffer, sealed: Buffer, aads: string[]): Buffer {
  let lastError: unknown;
  for (const aad of aads) {
    try {
      return open(key, sealed, aad);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export function hmac(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}
