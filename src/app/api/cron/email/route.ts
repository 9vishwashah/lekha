import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { anonDb } from "@/lib/supabase/server";
import { appUrl } from "@/lib/env";
import { openToken } from "@/lib/server/tokens";
import { emailConfigured, isEmail, sendEmail } from "@/lib/email/send";
import { activityDigestEmail, monthlyStatementEmail, monthlySummaryEmail, paise } from "@/lib/email/templates";
import type { NotificationRow } from "@/lib/notifications";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Scheduled email job (Vercel Cron calls it with "Authorization: Bearer $CRON_SECRET").
 *   - every run: the new-activity digest (unread alerts not yet emailed)
 *   - on the 1st (Indian time), or with ?monthly=1: monthly statements and owner summaries
 * The database functions it calls check the same secret, and record what was sent, so a repeated
 * run never sends anything twice.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = secret.length >= 24 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  if (!emailConfigured()) return NextResponse.json({ error: "RESEND_API_KEY and EMAIL_FROM are not set" }, { status: 500 });

  const db = anonDb();
  const base = appUrl();
  const report = { digests: 0, statements: 0, summaries: 0, failed: 0 };
  const clerk = await clerkClient();
  const emailsFor = async (ids: string[]) => {
    const map = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await clerk.users.getUserList({ userId: ids.slice(i, i + 100), limit: 100 });
      for (const u of data) {
        const e = u.primaryEmailAddress?.emailAddress;
        if (e) map.set(u.id, e);
      }
    }
    return map;
  };

  // 1. New activity digest
  const { data: groups, error } = await db.rpc("email_digest_claim", { p_secret: secret, p_limit: 500 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const digest = (groups as { user_id: string; name: string | null; items: Omit<NotificationRow, "id" | "read_at">[] }[]) ?? [];
  const digestEmails = await emailsFor(digest.map((g) => g.user_id));
  for (const g of digest) {
    const to = digestEmails.get(g.user_id);
    if (!isEmail(to)) continue;
    const items = g.items.map((x, n) => ({ ...x, id: n + 1, read_at: null })) as NotificationRow[];
    const sent = await sendEmail(to, activityDigestEmail({ name: g.name, items, appUrl: base }), { tag: "activity_digest" });
    if (sent.ok) report.digests += 1;
    else report.failed += 1;
  }

  // 2. Monthly, on the 1st in India (or when asked)
  const indiaToday = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  if (indiaToday.endsWith("-01") || new URL(request.url).searchParams.get("monthly") === "1") {
    const { data: monthly, error: mErr } = await db.rpc("email_monthly_claim", { p_secret: secret, p_month: indiaToday });
    if (mErr) return NextResponse.json({ error: mErr.message, ...report }, { status: 500 });
    // The statement covers the month that just ended.
    const prev = new Date(`${indiaToday.slice(0, 7)}-01T00:00:00Z`);
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    const label = prev.toISOString().slice(0, 7);
    const m = monthly as {
      clients: { client_name: string; client_email: string; business: string; owner_name: string | null; balance: number | string; share_cipher: string | null }[];
      owners: { user_id: string; name: string | null; workspace: string; owed_to_you: number | string; you_owe: number | string; top: { name: string; balance: number | string }[] }[];
    };
    for (const c of m.clients) {
      if (!isEmail(c.client_email)) continue;
      const token = openToken(c.share_cipher);
      const email = monthlyStatementEmail({ business: c.business, ownerName: c.owner_name, clientName: c.client_name, balance: paise(c.balance), month: label, statementUrl: token ? `${base}/s/${token}` : null });
      const sent = await sendEmail(c.client_email, email, { fromName: c.business, tag: "monthly_statement" });
      if (sent.ok) report.statements += 1;
      else report.failed += 1;
    }
    const ownerEmails = await emailsFor(m.owners.map((o) => o.user_id));
    for (const o of m.owners) {
      const to = ownerEmails.get(o.user_id);
      if (!isEmail(to)) continue;
      const email = monthlySummaryEmail({
        name: o.name,
        workspace: o.workspace,
        month: label,
        owedToYou: paise(o.owed_to_you),
        youOwe: paise(o.you_owe),
        top: o.top.map((t) => ({ name: t.name, balance: paise(t.balance) })),
        appUrl: base,
      });
      const sent = await sendEmail(to, email, { tag: "monthly_summary" });
      if (sent.ok) report.summaries += 1;
      else report.failed += 1;
    }
  }

  return NextResponse.json({ ok: true, ...report });
}
