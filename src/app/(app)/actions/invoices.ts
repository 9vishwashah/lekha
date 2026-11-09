"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { getWorkspace, requireUser } from "@/lib/server/context";
import { type ActionResult, fail } from "@/lib/server/errors";
import { newToken, sealToken } from "@/lib/server/tokens";
import { invoiceLink, invoiceShareUrl } from "@/lib/server/invoices";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");
const amount = z.union([z.string(), z.number().transform(String)]).transform((s) => s.trim().replace(/,/g, ""));
const numberText = z.union([z.string(), z.number().transform(String)]).optional().transform((s) => (s ?? "").trim());

const issues = (e: z.ZodError) => Object.fromEntries(e.issues.map((i) => [i.path.join("."), i.message]));

const refresh = (id?: string) => {
  revalidatePath("/invoices");
  if (id) revalidatePath(`/invoices/${id}`);
};

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------
const settingsSchema = z.object({
  business_name: z.string().trim().min(1, "Add your business name").max(160),
  email: z.string().trim().email("Enter a valid email").max(200).or(z.literal("")),
  phone: z.string().trim().max(40),
  address: z.string().trim().max(500),
  website: z.string().trim().max(200),
  gst_registered: z.boolean(),
  gstin: z.string().trim().max(15),
  pan: z.string().trim().max(10),
  state_code: z.string().trim().max(2),
  signatory_name: z.string().trim().max(120),
  signatory_title: z.string().trim().max(120),
  template: z.enum(["modern", "minimal", "project", "classic", "tax", "compact"]),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a colour"),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a colour"),
  logo_position: z.enum(["left", "right"]),
  number_prefix: z.string().trim().min(1, "Add a prefix").max(20),
  proforma_prefix: z.string().trim().min(1, "Add a prefix").max(20),
  number_format: z.string().trim().min(1).max(60).refine((v) => v.includes("{SEQ}"), "Must contain {SEQ}"),
  number_padding: z.coerce.number().int().min(1).max(8),
  number_start: z.coerce.number().int().min(1).max(99999999),
  number_reset: z.enum(["yearly", "never"]),
  default_due_days: z.coerce.number().int().min(0).max(365),
  default_payment_terms: z.string().trim().max(200),
  default_terms: z.string().trim().max(3000),
  default_notes: z.string().trim().max(3000),
  default_footer: z.string().trim().max(300),
  default_profile_id: z.string().optional(),
  show_digital_qr: z.boolean(),
  round_off: z.boolean(),
  allow_payment_claims: z.boolean(),
  show_payment_history: z.boolean(),
  card_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).or(z.literal("")).optional(),
});

export async function saveInvoiceSettings(input: z.input<typeof settingsSchema>): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, fieldErrors: issues(parsed.error) };
  const { error } = await ctx.db.rpc("save_invoice_settings", { p_workspace: ctx.workspace.id, p: parsed.data });
  if (error) return fail(error);
  const color = await ctx.db.rpc("set_invoice_card_color", { p_workspace: ctx.workspace.id, p_color: parsed.data.card_color ?? "" });
  if (color.error) return fail(color.error);
  revalidatePath("/invoices", "layout");
  return { ok: true, message: "Invoice settings saved" };
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);

/** Logo, signature, stamp or fixed UPI QR. PNG or JPG only, so the PDF can embed them. */
export async function uploadBrandImage(form: FormData): Promise<ActionResult<{ path: string }>> {
  const ctx = await getWorkspace();
  const file = form.get("file");
  const field = z.enum(["logo_path", "signature_path", "stamp_path", "qr", "client"]).safeParse(form.get("field"));
  if (!field.success || !(file instanceof File) || !IMAGE_TYPES.has(file.type)) return { ok: false, error: "Choose a PNG or JPG image" };
  if (file.size > 900 * 1024) return { ok: false, error: "That image is too large. Try a smaller one." };
  const path = `${ctx.workspace.id}/${newToken().slice(0, 24)}.${file.type === "image/png" ? "png" : "jpg"}`;
  const up = await ctx.db.storage.from("invoice-brand").upload(path, file, { contentType: file.type, cacheControl: "31536000" });
  if (up.error) return { ok: false, error: "The image could not be uploaded. Try again." };
  if (field.data !== "qr" && field.data !== "client") {
    const { error } = await ctx.db.rpc("set_invoice_brand_image", { p_workspace: ctx.workspace.id, p_field: field.data, p_path: path });
    if (error) return fail(error);
    revalidatePath("/invoices", "layout");
  }
  return { ok: true, data: { path }, message: "Image saved" };
}

export async function clearBrandImage(field: "logo_path" | "signature_path" | "stamp_path"): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const { error } = await ctx.db.rpc("set_invoice_brand_image", { p_workspace: ctx.workspace.id, p_field: field, p_path: null });
  if (error) return fail(error);
  revalidatePath("/invoices", "layout");
  return { ok: true, message: "Image removed" };
}

const profileSchema = z.object({
  id: z.string().optional(),
  label: z.string().trim().min(1, "Name this profile").max(60),
  upi_id: z.string().trim().max(120),
  upi_payee: z.string().trim().max(120),
  upi_number: z.string().trim().max(20),
  upi_qr_path: z.string().optional().nullable(),
  bank_holder: z.string().trim().max(160),
  bank_name: z.string().trim().max(160),
  bank_branch: z.string().trim().max(200),
  bank_account: z.string().trim().max(40),
  bank_ifsc: z.string().trim().max(11),
  instructions: z.string().trim().max(1000),
});

export async function savePaymentProfile(input: z.input<typeof profileSchema>): Promise<ActionResult<{ id: string }>> {
  const ctx = await getWorkspace();
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const { data, error } = await ctx.db.rpc("save_payment_profile", { p_workspace: ctx.workspace.id, p: parsed.data });
  if (error) return fail(error);
  revalidatePath("/invoices/settings");
  return { ok: true, data: { id: data as string }, message: "Payment profile saved" };
}

export async function archivePaymentProfile(id: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("archive_payment_profile", { p_id: uuid.parse(id) });
  if (error) return fail(error);
  revalidatePath("/invoices/settings");
  return { ok: true, message: "Removed. Invoices already issued keep their details." };
}

const librarySchema = z.object({
  kind: z.enum(["item", "terms", "notes", "footer", "payment"]),
  title: z.string().trim().min(1, "Give it a name").max(160),
  body: z.string().trim().max(4000).optional(),
  unit: z.string().trim().max(20).optional(),
  rate: numberText,
  tax_rate: numberText,
  hsn: z.string().trim().max(12).optional(),
});

export async function saveLibraryItem(input: z.input<typeof librarySchema>): Promise<ActionResult<{ id: string }>> {
  const ctx = await getWorkspace();
  const parsed = librarySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const { data, error } = await ctx.db.rpc("save_invoice_library_item", { p_workspace: ctx.workspace.id, p: parsed.data });
  if (error) return fail(error);
  revalidatePath("/invoices/settings");
  return { ok: true, data: { id: data as string }, message: "Saved for next time" };
}

export async function deleteLibraryItem(id: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("delete_invoice_library_item", { p_id: uuid.parse(id) });
  if (error) return fail(error);
  revalidatePath("/invoices/settings");
  return { ok: true, message: "Removed" };
}

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------
const money = amount.pipe(z.string().regex(/^(\d{1,12}(\.\d{1,2})?)?$/, "Enter an amount like 1500 or 1500.50"));
const itemSchema = z.object({
  name: z.string().trim().min(1, "Every line needs a name").max(300),
  description: z.string().trim().max(4000).optional(),
  reference_url: z.string().trim().max(300).optional(),
  sku: z.string().trim().max(40).optional(),
  hsn: z.string().trim().max(12).optional(),
  quantity: numberText.pipe(z.string().regex(/^(\d{1,10}(\.\d{1,3})?)?$/, "Enter a quantity like 2 or 1.5")),
  unit: z.string().trim().max(20).optional(),
  rate: money,
  discount_percent: numberText,
  tax_rate: numberText,
});

const draftSchema = z.object({
  id: z.string().optional(),
  source: z.enum(["native", "uploaded"]).optional(),
  invoice_type: z.enum(["service", "product", "gst", "project", "proforma", "custom"]),
  invoice_no: z.string().trim().max(60).optional(),
  title: z.string().trim().max(200).optional(),
  invoice_date: isoDate,
  due_date: isoDate.or(z.literal("")).optional(),
  payment_terms: z.string().trim().max(200).optional(),
  contractor_id: z.string().optional(),
  ledger_id: z.string().optional(),
  save_client: z.boolean().optional(),
  client_name: z.string().trim().max(160).optional(),
  client_business: z.string().trim().max(160).optional(),
  client_contact: z.string().trim().max(160).optional(),
  client_phone: z.string().trim().max(20).optional(),
  client_email: z.string().trim().max(200).optional(),
  client_address: z.string().trim().max(500).optional(),
  client_gstin: z.string().trim().max(15).optional(),
  client_pan: z.string().trim().max(10).optional(),
  client_state: z.string().trim().max(60).optional(),
  client_country: z.string().trim().max(60).optional(),
  place_of_supply: z.string().trim().max(2).optional(),
  gst_enabled: z.boolean().optional(),
  discount_kind: z.enum(["amount", "percent"]),
  discount_value: numberText,
  charge_label: z.string().trim().max(80).optional(),
  charge_amount: numberText,
  round_off: z.boolean().optional(),
  notes: z.string().trim().max(3000).optional(),
  terms: z.string().trim().max(3000).optional(),
  footer: z.string().trim().max(300).optional(),
  template: z.string().optional(),
  payment_config: z.record(z.string(), z.unknown()),
  show_digital_qr: z.boolean().optional(),
  allow_payment_claims: z.boolean().optional(),
  show_payment_history: z.boolean().optional(),
  items: z.array(itemSchema).max(200),
  look: z.object({ document_mode: z.enum(["lekha", "uploaded", "both"]).optional(), client_logo_path: z.string().max(200).optional() }).optional(),
});

export type DraftInput = z.input<typeof draftSchema>;

export async function saveDraft(input: DraftInput): Promise<ActionResult<{ id: string }>> {
  const ctx = await getWorkspace();
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, fieldErrors: issues(parsed.error) };
  const { look, ...draft } = parsed.data;
  const { data, error } = await ctx.db.rpc("save_invoice", { p: { ...draft, workspace_id: ctx.workspace.id } });
  if (error) return fail(error);
  if (look) {
    const styled = await ctx.db.rpc("set_invoice_look", { p_id: data, p: look });
    if (styled.error) return fail(styled.error);
  }
  refresh(data as string);
  return { ok: true, data: { id: data as string }, message: "Draft saved" };
}

export async function deleteDraft(id: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("delete_draft_invoice", { p_id: uuid.parse(id) });
  if (error) return fail(error);
  refresh();
  return { ok: true, message: "Draft deleted" };
}

export async function duplicateInvoice(id: string, type?: string): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  const db = await userDb();
  const { data, error } = await db.rpc("duplicate_invoice", { p_id: uuid.parse(id), p_type: type ?? null });
  if (error) return fail(error);
  refresh();
  return { ok: true, data: { id: data as string }, message: type ? "Converted to a draft invoice" : "Duplicated as a new draft" };
}

/** Quick way to give a new client a ledger, so their invoices and receipts have somewhere to post. */
export async function createClientLedger(contractorId: string, name: string): Promise<ActionResult<{ id: string; name: string }>> {
  const ctx = await getWorkspace();
  const { data, error } = await ctx.db.rpc("create_ledger", {
    p: { workspace_id: ctx.workspace.id, name: name.slice(0, 120), ledger_type: "basic", perspective: "party", contractor_id: uuid.parse(contractorId) },
  });
  if (error) return fail(error);
  revalidatePath("/ledgers");
  return { ok: true, data: { id: data as string, name }, message: "Ledger created" };
}

// ---------------------------------------------------------------------------------------------
// Issuing and after
// ---------------------------------------------------------------------------------------------
export async function issueInvoice(id: string): Promise<ActionResult<{ invoiceNo: string; url: string }>> {
  await requireUser();
  const db = await userDb();
  const token = newToken();
  const sealed = sealToken(token);
  if (!sealed) return { ok: false, error: "Sharing is not configured: SHARE_LINK_SECRET is missing on the server." };
  const { data, error } = await db.rpc("issue_invoice", { p_id: uuid.parse(id), p_token: token, p_ciphertext: sealed });
  if (error) return fail(error);
  refresh(id);
  revalidatePath("/ledgers", "layout");
  return { ok: true, data: { invoiceNo: (data as { invoice_no: string }).invoice_no, url: await invoiceShareUrl(token) }, message: "Invoice issued" };
}

const amendSchema = z.object({
  due_date: isoDate.or(z.literal("")).optional(),
  notes: z.string().trim().max(3000).optional(),
  terms: z.string().trim().max(3000).optional(),
  show_digital_qr: z.boolean().optional(),
  allow_payment_claims: z.boolean().optional(),
  show_payment_history: z.boolean().optional(),
  payment_config: z.record(z.string(), z.unknown()).optional(),
});

export async function amendInvoice(id: string, input: z.input<typeof amendSchema>): Promise<ActionResult> {
  await requireUser();
  const parsed = amendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const db = await userDb();
  const { error } = await db.rpc("amend_issued_invoice", { p_id: uuid.parse(id), p: parsed.data });
  if (error) return fail(error);
  refresh(id);
  return { ok: true, message: "Updated. The change is on the invoice timeline." };
}

const lookSchema = z.object({
  document_mode: z.enum(["lekha", "uploaded", "both"]).optional(),
  card_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).or(z.literal("")).optional(),
  client_logo_path: z.string().max(200).optional(),
  title: z.string().trim().max(200).optional(),
});

/** What the client sees: which document, the title, card colour, their logo. Never the money. */
export async function updateClientPage(id: string, look: z.input<typeof lookSchema>, paymentConfig?: Record<string, unknown>): Promise<ActionResult> {
  await requireUser();
  const parsed = lookSchema.safeParse(look);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const db = await userDb();
  const { title, ...styling } = parsed.data;
  const { error } = await db.rpc("set_invoice_look", { p_id: uuid.parse(id), p: styling });
  if (error) return fail(error);
  if (title !== undefined) {
    const named = await db.rpc("set_invoice_title", { p_id: id, p_title: title });
    if (named.error) return fail(named.error);
  }
  if (paymentConfig) {
    const amended = await db.rpc("amend_issued_invoice", { p_id: id, p: { payment_config: paymentConfig } });
    if (amended.error) return fail(amended.error);
  }
  refresh(id);
  return { ok: true, message: "Client page updated" };
}

export async function cancelInvoice(id: string, reason: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("cancel_invoice", { p_id: uuid.parse(id), p_reason: reason });
  if (error) return fail(error);
  refresh(id);
  revalidatePath("/ledgers", "layout");
  return { ok: true, message: "Invoice cancelled. Its link no longer opens." };
}

const paymentSchema = z.object({
  amount: money.refine((v) => v !== "", "Enter the amount received"),
  paid_on: isoDate,
  mode: z.enum(["cash", "upi", "bank_transfer", "cheque", "card", "other"]).or(z.literal("")),
  reference: z.string().trim().max(80),
  notes: z.string().trim().max(1000),
  allow_excess: z.boolean().optional(),
  idempotency_key: z.string().min(8).max(120),
  wallet_ledger_id: uuid.or(z.literal("")),
  tds_deducted: z.string().trim().regex(/^(\d{1,12}(\.\d{1,2})?)?$/, "Enter the TDS like 10000").optional(),
});

export async function recordPayment(id: string, input: z.input<typeof paymentSchema>): Promise<ActionResult> {
  await requireUser();
  const parsed = paymentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, fieldErrors: issues(parsed.error) };
  const db = await userDb();
  const { data, error } = await db.rpc("record_invoice_payment", { p_invoice: uuid.parse(id), p: parsed.data });
  if (error) return fail(error);
  refresh(id);
  revalidatePath("/ledgers", "layout");
  revalidatePath("/books");
  revalidatePath("/dashboard");
  revalidatePath("/contractors", "layout");
  return { ok: true, message: (data as { duplicate: boolean }).duplicate ? "Already recorded" : "Payment recorded" };
}

export async function reversePayment(paymentId: string, invoiceId: string, reason: string, kind: "correction" | "refund"): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("reverse_invoice_payment", { p_id: uuid.parse(paymentId), p_reason: reason, p_kind: kind });
  if (error) return fail(error);
  refresh(invoiceId);
  revalidatePath("/ledgers", "layout");
  return { ok: true, message: kind === "refund" ? "Refund recorded" : "Payment reversed" };
}

export async function reviewSubmission(id: string, invoiceId: string, accept: boolean, input: { amount?: string; note?: string; allow_excess?: boolean } = {}): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("review_payment_submission", { p_id: uuid.parse(id), p_accept: accept, p: input });
  if (error) return fail(error);
  refresh(invoiceId);
  revalidatePath("/ledgers", "layout");
  return { ok: true, message: accept ? "Payment confirmed and posted" : "Marked as not received" };
}

export async function rotateLink(id: string, expiresInDays?: number): Promise<ActionResult<{ url: string }>> {
  await requireUser();
  const db = await userDb();
  const token = newToken();
  const sealed = sealToken(token);
  if (!sealed) return { ok: false, error: "Sharing is not configured: SHARE_LINK_SECRET is missing on the server." };
  const expires = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null;
  const { error } = await db.rpc("rotate_invoice_link", { p_invoice: uuid.parse(id), p_token: token, p_ciphertext: sealed, p_expires: expires });
  if (error) return fail(error);
  refresh(id);
  return { ok: true, data: { url: await invoiceShareUrl(token) }, message: "New link created. The old one no longer opens." };
}

export async function revokeLink(id: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("revoke_invoice_link", { p_invoice: uuid.parse(id) });
  if (error) return fail(error);
  refresh(id);
  return { ok: true, message: "Link turned off" };
}

export async function getInvoiceUrl(id: string): Promise<string | null> {
  await requireUser();
  return invoiceLink(await userDb(), uuid.parse(id));
}

export async function markShared(id: string): Promise<void> {
  await requireUser();
  const db = await userDb();
  await db.rpc("mark_invoice_shared", { p_invoice: uuid.parse(id) });
  refresh(id);
}

export async function recordReminder(id: string, stage: string): Promise<ActionResult> {
  await requireUser();
  const parsed = z.enum(["before_due", "on_due", "after_due", "custom"]).safeParse(stage);
  if (!parsed.success) return { ok: false, error: "Choose a reminder" };
  const db = await userDb();
  const { error } = await db.rpc("record_invoice_reminder", { p_invoice: uuid.parse(id), p_stage: parsed.data });
  if (error) return fail(error);
  refresh(id);
  return { ok: true };
}

export async function setFileVisibility(fileId: string, invoiceId: string, visible: boolean): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("set_attachment_visibility", { p_id: uuid.parse(fileId), p_visible: visible });
  if (error) return fail(error);
  refresh(invoiceId);
  return { ok: true, message: visible ? "Your client can now download this file" : "Hidden from your client" };
}

export async function removeFile(fileId: string, invoiceId: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { data, error } = await db.rpc("remove_invoice_attachment", { p_id: uuid.parse(fileId) });
  if (error) return fail(error);
  if (data) await db.storage.from("invoice-files").remove([data as string]);
  refresh(invoiceId);
  return { ok: true, message: "File removed" };
}
