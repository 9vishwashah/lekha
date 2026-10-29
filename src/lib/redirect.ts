/**
 * A same-site path to send someone to after signing in, or null for anything else (no open
 * redirects). Absolute URLs are accepted only on this app's own origin and reduced to the path.
 */
export function safeReturnPath(v: unknown, origin?: string): string | null {
  if (typeof v !== "string" || v.length > 512) return null;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return origin && u.origin === new URL(origin).origin ? `${u.pathname}${u.search}` : null;
    } catch {
      return null;
    }
  }
  return v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : null;
}
