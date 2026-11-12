import "server-only";
import type { Email } from "./templates";

/**
 * Sends through Resend's HTTP API (no extra package). Configure on the server:
 *   RESEND_API_KEY  re_...
 *   EMAIL_FROM      e.g. "Lekha <notify@lekha.vjas.in>"  (a domain verified in Resend)
 */
export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(
  to: string,
  email: Email,
  options: { replyTo?: string | null; fromName?: string | null; tag?: string; idempotencyKey?: string } = {},
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return { ok: false, error: "Email is not set up yet: add RESEND_API_KEY and EMAIL_FROM on the server." };
  // "Business name via Lekha <notify@...>" so the inbox shows who it is from; the address stays verified.
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const sender = options.fromName ? `${options.fromName.replace(/["<>]/g, "").slice(0, 60)} via Lekha <${address}>` : from;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify({
        from: sender,
        to: [to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(options.replyTo ? { reply_to: options.replyTo } : {}),
        ...(options.tag ? { tags: [{ name: "type", value: options.tag }] } : {}),
      }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !body.id) return { ok: false, error: body.message ?? `Email could not be sent (${res.status})` };
    return { ok: true, id: body.id };
  } catch {
    return { ok: false, error: "Email could not be sent. Try again." };
  }
}

export const isEmail = (s: string | null | undefined): s is string => Boolean(s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
