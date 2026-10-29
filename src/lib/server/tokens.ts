import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 32 random bytes, base64url: unguessable and safe in a URL path. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function key(): Buffer | null {
  const raw = process.env.SHARE_LINK_SECRET;
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

/**
 * AES-256-GCM so the owner can copy an active link again. The key lives only on the app server;
 * the database stores the ciphertext and a SHA-256 hash used for lookup.
 */
export function sealToken(token: string): string | null {
  const k = key();
  if (!k) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function openToken(sealed: string | null | undefined): string | null {
  const k = key();
  if (!k || !sealed) return null;
  try {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1") return null;
    const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
