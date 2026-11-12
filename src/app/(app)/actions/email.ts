"use server";
import { revalidatePath } from "next/cache";
import { currentUser } from "@clerk/nextjs/server";
import { z } from "zod";
import { getMyProfile, getWorkspace, requireUser } from "@/lib/server/context";
import { userDb } from "@/lib/supabase/server";
import { type ActionResult, fail } from "@/lib/server/errors";
import { invoiceLink } from "@/lib/server/invoices";
import { getShareUrl } from "./ledgers";
import { emailConfigured, isEmail, sendEmail } from "@/lib/email/send";
import { invoiceEmail, paymentReminderEmail } from "@/lib/email/templates";
import { toPaise } from "@/lib/domain/money";

const uuid = z.string().uuid();

async function senderIdentity() {
  const [user, profile] = await Promise.all([currentUser(), getMyProfile()]);
  return { name: profile?.full_name || user?.fullName || "Lekha user", email: user?.primaryEmailAddress?.emailAddress ?? null };
}

async function businessName(db: Awaited<ReturnType<typeof userDb>>, workspaceId: string, fallback: string) {
  const { data } = await db.from("invoice_settings").select("business_name").eq("workspace_id", workspaceId).maybeSingle();
  return (data?.business_name as string | null) || fallback;
}

/** "Send reminder" on a client's page: emails them what they owe, with their statement link. */
export async function sendClientReminder(contractorId: string, note?: string): Promise<ActionResult> {
  const ctx = await getWorkspace();
  if (!emailConfigured()) return { ok: false, error: "Email is not set up yet. Add RESEND_API_KEY and EMAIL_FROM on the server." };
  const id = uuid.parse(contractorId);
  const message = z.string().trim().max(500).optional().parse(note);
  const { data: c } = await ctx.db.from("contractors").select("id, name, email").eq("id", id).eq("workspace_id", ctx.workspace.id).maybeSingle();
  if (!c) return { ok: false, error: "Client not found" };
  if (!isEmail(c.email)) return { ok: false, error: `Add ${c.name}'s email address first (Edit on their page).` };
  const { data: bal, error: balError } = await ctx.db.rpc("client_balance", { p_contractor: id });
  if (balError) return fail(balError);
  const balance = toPaise(String(bal ?? 0));
  if (balance <= 0n) return { ok: false, error: `Nothing is pending from ${c.name}.` };
  const limited = await ctx.db.rpc("note_client_reminder", { p_contractor: id });
  if (limited.error) return fail(limited.error);

  // Their statement link: the account with them (expenses and payments) first, then a party ledger.
  const { data: ledgers } = await ctx.db
    .from("ledgers")
    .select("id, is_direct")
    .eq("workspace_id", ctx.workspace.id)
    .eq("contractor_id", id)
    .order("is_direct", { ascending: false });
  let statementUrl: string | null = null;
  for (const l of ledgers ?? []) {
    statementUrl = await getShareUrl(l.id as string);
    if (statementUrl) break;
  }
  const [me, business] = await Promise.all([senderIdentity(), businessName(ctx.db, ctx.workspace.id, ctx.workspace.name)]);
  const email = paymentReminderEmail({ business, sender: me.name, clientName: c.name, balance, note: message, statementUrl });
  const sent = await sendEmail(c.email, email, { replyTo: me.email, fromName: business, tag: "payment_reminder" });
  if (!sent.ok) return { ok: false, error: sent.error };
  revalidatePath(`/contractors/${id}`);
  return { ok: true, message: `Reminder emailed to ${c.email}` };
}

/** Monthly statement email for one client, on or off. */
export async function setClientMonthlyStatement(contractorId: string, on: boolean): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const { error } = await ctx.db.rpc("set_client_monthly_statement", { p_contractor: uuid.parse(contractorId), p_on: on });
  if (error) return fail(error);
  revalidatePath(`/contractors/${contractorId}`);
  return { ok: true, message: on ? "Monthly statement on: they get it on the 1st" : "Monthly statement off" };
}

/** Your own email settings. */
export async function setEmailPrefs(prefs: { newActivity?: boolean; monthly?: boolean }): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("set_my_email_prefs", { p_new_activity: prefs.newActivity ?? null, p_monthly: prefs.monthly ?? null });
  if (error) return fail(error);
  revalidatePath("/settings");
  return { ok: true, message: "Email settings saved" };
}

/** "Email invoice": sends the invoice link to the client's email address. */
export async function emailInvoice(invoiceId: string, to?: string): Promise<ActionResult> {
  const ctx = await getWorkspace();
  if (!emailConfigured()) return { ok: false, error: "Email is not set up yet. Add RESEND_API_KEY and EMAIL_FROM on the server." };
  const id = uuid.parse(invoiceId);
  const { data: i } = await ctx.db
    .from("invoices")
    .select("id, status, invoice_no, invoice_type, client_name, client_contact, client_email, grand_total, amount_received, due_date, seller_snapshot")
    .eq("id", id)
    .maybeSingle();
  if (!i) return { ok: false, error: "Invoice not found" };
  if (i.status !== "issued") return { ok: false, error: "Issue the invoice first" };
  const address = (to?.trim() || i.client_email) as string | null;
  if (!isEmail(address)) return { ok: false, error: "Add the client's email address" };
  const url = await invoiceLink(ctx.db, id);
  if (!url) return { ok: false, error: "This invoice's link is off or expired. Turn the link on first." };
  const me = await senderIdentity();
  const business = (i.seller_snapshot as { business_name?: string } | null)?.business_name || ctx.workspace.name;
  const total = toPaise(String(i.grand_total));
  const email = invoiceEmail({
    business,
    sender: me.name,
    clientName: (i.client_contact as string | null) || (i.client_name as string),
    invoiceNo: i.invoice_no as string,
    total,
    balance: total - toPaise(String(i.amount_received)),
    dueDate: i.due_date as string | null,
    url,
    proforma: i.invoice_type === "proforma",
  });
  const sent = await sendEmail(address, email, { replyTo: me.email, fromName: business, tag: "invoice", idempotencyKey: `invoice:${id}:${address}:${new Date().toISOString().slice(0, 13)}` });
  if (!sent.ok) return { ok: false, error: sent.error };
  await ctx.db.rpc("mark_invoice_shared", { p_invoice: id });
  revalidatePath(`/invoices/${id}`);
  return { ok: true, message: `Invoice emailed to ${address}` };
}
