"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { getMyProfile, getWorkspace, requireUser } from "@/lib/server/context";
import { type ActionResult, fail } from "@/lib/server/errors";
import { newToken, openToken, sealToken } from "@/lib/server/tokens";
import { appUrl } from "@/lib/env";
import { getLedger, getLedgerTxns } from "@/lib/server/queries";
import type { SharedPayload } from "@/lib/server/shared";
import { loadShareCard, shareMessage, summarizeShare, whatsappNumber } from "@/lib/server/share-card";

const uuid = z.string().uuid();
// Amounts arrive as text from forms, but as numbers when a form was filled from stored values.
const text = z.union([z.string(), z.number().transform(String)]);
const money = text
  .pipe(z.string())
  .transform((s) => s.trim())
  .transform((s) => s.replace(/,/g, ""))
  .pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 1500 or 1500.50"));
const signedMoney = text
  .pipe(z.string())
  .transform((s) => s.trim())
  .transform((s) => s.replace(/,/g, ""))
  .pipe(z.string().regex(/^-?\d{0,12}(\.\d{1,2})?$/, "Enter an amount like 1500 or -1500"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const rate = z.string().trim().regex(/^\d{1,2}(\.\d{1,3})?$/, "Enter a rate like 18 or 0.1");

function fieldErrors(error: z.ZodError) {
  return Object.fromEntries(error.issues.map((i) => [i.path.join("."), i.message]));
}

function refreshLedger(id: string) {
  revalidatePath(`/ledgers/${id}`);
  revalidatePath("/ledgers");
  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------------------------
const ledgerSchema = z.object({
  name: z.string().trim().min(1, "Give the ledger a name").max(120),
  ledger_type: z.enum(["basic", "taxation", "personal"]),
  perspective: z.enum(["cashbook", "party"]).optional(),
  wallet_kind: z.enum(["cash", "bank"]).optional().or(z.literal("")),
  contractor_id: uuid.optional().or(z.literal("")).transform((v) => v || undefined),
  reference_no: optionalText(60),
  opening_balance: signedMoney.optional().or(z.literal("")),
  opening_balance_date: isoDate.optional().or(z.literal("")),
  description: optionalText(500),
  gst_mode: z.enum(["intra", "inter"]).optional(),
  color: z.enum(["mustard", "lavender", "tea", "pink", "tangerine", "sky", "red", "ink"]).optional(),
  participant_client_ids: z.array(uuid).max(30).optional(),
});

export async function createLedger(_: unknown, form: FormData): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const raw = Object.fromEntries(form);
  const parsed = ledgerSchema.safeParse({
    ...raw,
    participant_client_ids: form.getAll("participant_client_ids").map(String).filter(Boolean),
  });
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields", fieldErrors: fieldErrors(parsed.error) };
  // Your real name: other people in a shared account see it ("You" is only ever shown on your own screen).
  const [profile, user] = await Promise.all([getMyProfile(), currentUser()]);
  const ownerName = profile?.full_name || ctx.displayName || user?.fullName || user?.firstName || user?.username || "Owner";
  if (parsed.data.ledger_type === "personal" && !parsed.data.participant_client_ids?.length) {
    return { ok: false, error: "Choose at least one other person", fieldErrors: { participant_client_ids: "Choose at least one other person" } };
  }
  const { data, error } = await ctx.db.rpc("create_ledger", {
    p: { ...parsed.data, workspace_id: ctx.workspace.id, owner_name: ownerName },
  });
  if (error) return fail(error);
  revalidatePath("/ledgers");
  redirect(`/ledgers/${data}`);
}

export async function updateLedger(ledgerId: string, _: unknown, form: FormData): Promise<ActionResult> {
  await requireUser();
  const parsed = ledgerSchema.partial().safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields", fieldErrors: fieldErrors(parsed.error) };
  const db = await userDb();
  const p: Record<string, unknown> = { ...parsed.data };
  delete p.ledger_type;
  for (const key of ["contractor_id", "reference_no", "description", "opening_balance_date"]) if (!(key in p)) p[key] = "";
  const { error } = await db.rpc("update_ledger", { p_ledger: uuid.parse(ledgerId), p });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Ledger updated" };
}

export async function setLedgerStatus(ledgerId: string, status: "active" | "archived"): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("set_ledger_status", { p_ledger: uuid.parse(ledgerId), p_status: status });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: status === "archived" ? "Ledger archived" : "Ledger restored" };
}

/** Deletes a ledger for good. The database checks the typed name again and refuses while anything depends on it. */
export async function deleteLedger(ledgerId: string, confirmName: string): Promise<ActionResult> {
  const db = await userDb();
  const { data, error } = await db.rpc("delete_ledger", { p_ledger: uuid.parse(ledgerId), p_confirm: confirmName });
  if (error) return fail(error);
  revalidatePath("/ledgers", "layout");
  revalidatePath("/dashboard");
  revalidatePath("/books");
  revalidatePath("/contractors", "layout");
  const res = data as { name: string; entries: number };
  return { ok: true, message: `Deleted ${res.name} and ${res.entries} ${res.entries === 1 ? "entry" : "entries"}` };
}

export async function addParticipant(ledgerId: string, clientId: string): Promise<ActionResult> {
  const parsed = uuid.safeParse(clientId);
  if (!parsed.success) return { ok: false, error: "Choose someone from your client accounts" };
  const db = await userDb();
  const { error } = await db.rpc("add_ledger_participant", { p_ledger: uuid.parse(ledgerId), p_client: parsed.data });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Added to this account" };
}

// ---------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------
const taxSchema = z.object({
  taxable_amount: money,
  gst_applicable: z.boolean(),
  gst_type: z.enum(["intra", "inter"]),
  gst_rate: rate.optional().or(z.literal("")),
  tds_applicable: z.boolean(),
  tds_rate: rate.optional().or(z.literal("")),
  tds_base: z.enum(["taxable", "gross"]),
  tds_section: optionalText(20),
  invoice_no: optionalText(60),
  invoice_date: isoDate.optional().or(z.literal("")),
  tax_status: z.enum(["pending", "paid", "not_applicable"]).optional(),
});

const entryBase = z.object({
    ledger_id: uuid,
    kind: z.enum(["regular", "invoice"]),
    direction: z.enum(["in", "out"], { message: "Choose Money In or Money Out" }),
    amount: money.optional(),
    txn_date: isoDate,
    description: optionalText(500),
    counterparty: optionalText(160),
    payment_mode: z.enum(["cash", "upi", "bank_transfer", "cheque", "card", "other"]).optional().or(z.literal("")),
    reference_no: optionalText(80),
    notes: optionalText(2000),
    status: z.enum(["draft", "posted"]).default("posted"),
    idempotency_key: z.string().min(8).max(120).optional(),
    tax: taxSchema.nullable().optional(),
    wallet_ledger_id: uuid.optional().or(z.literal("")),
    nature: z.enum(["direct_income", "income", "direct_expense", "expense", "capital", "drawings", "transfer"]).optional().or(z.literal("")),
});

const entrySchema = entryBase
  .refine((v) => v.kind === "invoice" || !!v.amount, { message: "Enter an amount", path: ["amount"] })
  .refine((v) => v.kind === "regular" || !!v.tax, { message: "A bill needs its tax details", path: ["tax"] });

export type EntryInput = z.input<typeof entrySchema>;

export async function postEntry(input: EntryInput): Promise<ActionResult<{ voucher: string }>> {
  await requireUser();
  const parsed = entrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, fieldErrors: fieldErrors(parsed.error) };
  const db = await userDb();
  const { data, error } = await db.rpc("post_transaction", { p: parsed.data });
  if (error) return fail(error);
  refreshLedger(parsed.data.ledger_id);
  const res = data as { voucher_no: string; duplicate: boolean };
  return { ok: true, data: { voucher: res.voucher_no }, message: res.duplicate ? "Already saved" : `Saved as ${res.voucher_no}` };
}

export async function amendEntry(id: string, ledgerId: string, input: Partial<Omit<EntryInput, "kind">> & { kind?: undefined }): Promise<ActionResult> {
  await requireUser();
  const parsed = entryBase.partial().omit({ ledger_id: true, kind: true }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, fieldErrors: fieldErrors(parsed.error) };
  // A field emptied in the form is sent as null so the stored text is cleared, not left as it was.
  const cleared = Object.fromEntries((["description", "counterparty", "reference_no", "notes"] as const).filter((k) => input[k] === "").map((k) => [k, null]));
  const db = await userDb();
  const { error } = await db.rpc("amend_transaction", { p_id: uuid.parse(id), p: { ...parsed.data, ...cleared } });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Entry updated" };
}

const MEANINGS_IN = ["", "direct_income", "income", "capital", "transfer"] as const;
const MEANINGS_OUT = ["", "direct_expense", "expense", "drawings", "transfer"] as const;
const booksSchema = z.object({
  default_in_nature: z.enum(MEANINGS_IN).optional(),
  default_out_nature: z.enum(MEANINGS_OUT).optional(),
});

/** What a cash or bank ledger's plain money in and out usually count as. */
export async function setLedgerBooks(ledgerId: string, input: z.input<typeof booksSchema>): Promise<ActionResult> {
  const parsed = booksSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const db = await userDb();
  const { error } = await db.rpc("set_ledger_books", { p_ledger: uuid.parse(ledgerId), p: parsed.data });
  if (error) return fail(error);
  revalidatePath("/ledgers", "layout");
  revalidatePath("/books");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  return { ok: true, message: "Saved. Every entry without its own meaning now follows this." };
}

/** Whether an expense category is a direct cost of the trade or an indirect one. */
export async function setCategoryHead(categoryId: string, head: "direct" | "indirect"): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("set_category_head", { p_category: uuid.parse(categoryId), p_head: head });
  if (error) return fail(error);
  revalidatePath("/books");
  revalidatePath("/dashboard");
  return { ok: true, message: head === "direct" ? "Counted as a direct expense" : "Counted as an indirect expense" };
}

/** Which wallet an entry went through, or what it was. The money itself does not change. */
export async function classifyEntry(id: string, input: { wallet_ledger_id?: string; nature?: string }): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("classify_entry", { p_id: uuid.parse(id), p: input });
  if (error) return fail(error);
  revalidatePath("/ledgers", "layout");
  revalidatePath("/books");
  revalidatePath("/dashboard");
  return { ok: true, message: "Saved" };
}

export async function deleteEntry(id: string, ledgerId: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("delete_transaction", { p_id: uuid.parse(id) });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  revalidatePath("/ledgers", "layout");
  revalidatePath("/books");
  return { ok: true, message: "Entry deleted" };
}

export async function reverseEntry(id: string, ledgerId: string, reason: string, date: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("reverse_transaction", { p_id: uuid.parse(id), p_reason: reason, p_date: isoDate.parse(date) });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Reversal posted" };
}

const settlementSchema = z.object({
  ledger_id: uuid,
  txn_date: isoDate,
  tax_type: z.enum(["gst", "tds", "other"]),
  amount: money,
  account_mapping: z.enum(["gst_payable", "gst_input_credit", "tds_payable", "other"]).optional(),
  period_month: isoDate.optional().or(z.literal("")),
  challan_no: optionalText(60),
  payment_mode: z.enum(["cash", "upi", "bank_transfer", "cheque", "card", "other"]).optional().or(z.literal("")),
  description: optionalText(500),
  settlement_status: z.enum(["pending", "completed"]).optional(),
  idempotency_key: z.string().min(8).max(120).optional(),
  wallet_ledger_id: uuid.optional().or(z.literal("")),
});

export async function recordTaxPayment(input: z.input<typeof settlementSchema>): Promise<ActionResult> {
  const parsed = settlementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, fieldErrors: fieldErrors(parsed.error) };
  const db = await userDb();
  const { error } = await db.rpc("record_tax_settlement", { p: parsed.data });
  if (error) return fail(error);
  refreshLedger(parsed.data.ledger_id);
  if (parsed.data.wallet_ledger_id) revalidatePath(`/ledgers/${parsed.data.wallet_ledger_id}`);
  revalidatePath("/books");
  revalidatePath("/reports/tax");
  return { ok: true, message: "Tax payment recorded" };
}

// ---------------------------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------------------------
const shareOptions = z.object({
  show_balance: z.boolean(),
  show_running_balance: z.boolean(),
  show_tax: z.boolean(),
  show_reference: z.boolean(),
  show_counterparty: z.boolean(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

export async function createShareLink(ledgerId: string, options: z.input<typeof shareOptions>): Promise<ActionResult<{ url: string }>> {
  const parsed = shareOptions.safeParse(options);
  if (!parsed.success) return { ok: false, error: "Check the sharing options" };
  const token = newToken();
  const db = await userDb();
  const { error } = await db.rpc("create_share_link", {
    p_ledger: uuid.parse(ledgerId),
    p_token: token,
    p_ciphertext: sealToken(token),
    p: parsed.data,
  });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, data: { url: `${appUrl()}/s/${token}` }, message: "Share link is live" };
}

export async function updateShareLink(id: string, ledgerId: string, options: z.input<typeof shareOptions>): Promise<ActionResult> {
  const parsed = shareOptions.partial().safeParse(options);
  if (!parsed.success) return { ok: false, error: "Check the sharing options" };
  const db = await userDb();
  const { error } = await db.rpc("update_share_link", { p_id: uuid.parse(id), p: parsed.data });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Sharing updated" };
}

export async function revokeShareLink(id: string, ledgerId: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("revoke_share_link", { p_id: uuid.parse(id) });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Link turned off. It no longer opens." };
}

export interface ShareState {
  link: {
    id: string;
    token_hint: string;
    show_balance: boolean;
    show_running_balance: boolean;
    show_tax: boolean;
    show_reference: boolean;
    show_counterparty: boolean;
    expires_at: string | null;
    last_accessed_at: string | null;
    created_at: string;
  } | null;
  url: string | null;
  /** Prefilled WhatsApp text, written from what the recipient will see. */
  message: string | null;
  /** The client's WhatsApp number (digits with country code), when their phone is saved. */
  whatsappTo: string | null;
  expired: boolean;
}

export async function getShareState(ledgerId: string): Promise<ShareState> {
  const db = await userDb();
  const { data } = await db
    .from("share_links")
    .select("id, token_hint, show_balance, show_running_balance, show_tax, show_reference, show_counterparty, expires_at, last_accessed_at, created_at")
    .eq("ledger_id", uuid.parse(ledgerId))
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return { link: null, url: null, message: null, whatsappTo: null, expired: false };
  const expired = Boolean(data.expires_at && new Date(data.expires_at) <= new Date());
  const url = expired ? null : await getShareUrl(ledgerId);
  const composed = url ? await composeShareMessage(ledgerId, url, data) : null;
  return { link: data, url, message: composed?.message ?? null, whatsappTo: composed?.whatsappTo ?? null, expired };
}

/**
 * The WhatsApp text, built from the owner's own view of the ledger with the link's settings applied
 * (so it states only what the recipient can see). It does not open the public link, which would
 * count as the recipient opening it. Also returns the client's number so the chat opens directly.
 */
async function composeShareMessage(ledgerId: string, url: string, options: NonNullable<ShareState["link"]>) {
  const db = await userDb();
  const token = url.slice(url.lastIndexOf("/") + 1);
  const [ledger, txns, card] = await Promise.all([getLedger(db, ledgerId), getLedgerTxns(db, ledgerId), loadShareCard(token)]);
  const posted = txns.filter((t) => t.status === "posted").map((t) => ({ ...t, date: t.txn_date }));
  const payload: SharedPayload = {
    ledger: {
      name: ledger.name,
      ledger_type: ledger.ledger_type,
      perspective: ledger.perspective,
      contractor_name: ledger.contractor?.name ?? null,
      opening_balance: options.show_balance ? ledger.opening_balance : null,
      opening_balance_date: ledger.opening_balance_date,
      last_activity_at: ledger.last_activity_at,
    },
    options,
    transactions: posted,
    participants: null,
    shared_expenses: null,
    settlements: null,
  };
  const personal = ledger.ledger_type === "personal";
  return {
    message: shareMessage(summarizeShare(payload, card), url, personal),
    whatsappTo: personal ? null : whatsappNumber(ledger.contractor?.phone),
  };
}

/** Rebuilds the active link for the owner (decrypting the stored token on the server). */
export async function getShareUrl(ledgerId: string): Promise<string | null> {
  const db = await userDb();
  const { data } = await db.rpc("share_link_secret", { p_ledger: uuid.parse(ledgerId) });
  const token = openToken(data as string | null);
  return token ? `${appUrl()}/s/${token}` : null;
}

// ---------------------------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------------------------
const permissions = z.object({
  can_create: z.boolean(),
  can_edit_own: z.boolean(),
  can_edit_all: z.boolean(),
  can_attach: z.boolean(),
  can_view_tax: z.boolean(),
});

export async function inviteCollaborator(
  ledgerId: string,
  input: z.input<typeof permissions> & { email?: string; participant_id?: string },
): Promise<ActionResult<{ url: string }>> {
  const parsed = permissions
    .extend({
      email: z.string().trim().email().max(200).optional().or(z.literal("")),
      participant_id: uuid.optional().or(z.literal("")),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const token = newToken();
  const db = await userDb();
  const { error } = await db.rpc("create_invitation", {
    p_token: token,
    p: { ...parsed.data, scope: "ledger", ledger_id: uuid.parse(ledgerId) },
  });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, data: { url: `${appUrl()}/invite/${token}` }, message: "Invitation link created" };
}

export async function updateCollaborator(id: string, ledgerId: string, input: Partial<z.input<typeof permissions>>): Promise<ActionResult> {
  const parsed = permissions.partial().safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the permissions" };
  const db = await userDb();
  const { error } = await db.rpc("update_collaborator", { p_id: uuid.parse(id), p: parsed.data });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Permissions updated" };
}

export async function revokeCollaborator(id: string, ledgerId: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("revoke_collaborator", { p_id: uuid.parse(id) });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Access removed" };
}

export async function revokeLedgerInvitation(id: string, ledgerId: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("revoke_invitation", { p_id: uuid.parse(id) });
  if (error) return fail(error);
  refreshLedger(ledgerId);
  return { ok: true, message: "Invitation cancelled" };
}
