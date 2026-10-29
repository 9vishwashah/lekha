"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { getWorkspace, requireUser } from "@/lib/server/context";
import { type ActionResult, fail } from "@/lib/server/errors";
import { computeShares, type SplitMethod } from "@/lib/domain/split";
import { toDecimal, toPaise, MoneyError } from "@/lib/domain/money";

const uuid = z.string().uuid();
const money = z
  .string()
  .trim()
  .transform((s) => s.replace(/,/g, ""))
  .pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 1500 or 1500.50"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const mode = z.enum(["cash", "upi", "bank_transfer", "cheque", "card", "other"]).optional().or(z.literal(""));
const optionalId = uuid.optional().or(z.literal("")).transform((v) => v || undefined);

const errors = (e: z.ZodError) => Object.fromEntries(e.issues.map((i) => [i.path.join("."), i.message]));

// ---------------------------------------------------------------------------------------------
// Contractors
// ---------------------------------------------------------------------------------------------
const contractorSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(160),
  kind: z.enum(["business", "personal"]).default("business"),
  business_name: optionalText(160),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+() -]{6,20}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  email: z.string().trim().email("Enter a valid email").max(200).optional().or(z.literal("")).transform((v) => v || null),
  address: optionalText(500),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "GSTIN should look like 27AAPFU0939F1ZV")
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN should look like AAPFU0939F")
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  notes: optionalText(2000),
});

export async function saveContractor(id: string | null, _: unknown, form: FormData): Promise<ActionResult<{ id: string }>> {
  const ctx = await getWorkspace();
  const parsed = contractorSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields", fieldErrors: errors(parsed.error) };
  const values = { ...parsed.data, business_name: parsed.data.business_name ?? null, address: parsed.data.address ?? null, notes: parsed.data.notes ?? null };
  if (id) {
    const { error } = await ctx.db
      .from("contractors")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", uuid.parse(id))
      .eq("workspace_id", ctx.workspace.id);
    if (error) return fail(error);
    revalidatePath(`/contractors/${id}`);
    revalidatePath("/contractors");
    return { ok: true, data: { id }, message: "Client saved" };
  }
  const { data, error } = await ctx.db
    .from("contractors")
    .insert({ ...values, workspace_id: ctx.workspace.id, created_by: ctx.userId })
    .select("id")
    .single();
  if (error) return fail(error);
  revalidatePath("/contractors");
  return { ok: true, data: { id: data.id }, message: "Client added" };
}

export async function setContractorActive(id: string, active: boolean): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const { error } = await ctx.db.from("contractors").update({ is_active: active }).eq("id", uuid.parse(id)).eq("workspace_id", ctx.workspace.id);
  if (error) return fail(error);
  revalidatePath(`/contractors/${id}`);
  revalidatePath("/contractors");
  return { ok: true, message: active ? "Client reactivated" : "Client marked inactive" };
}

export async function mergeContractors(fromId: string, intoId: string): Promise<ActionResult> {
  await getWorkspace();
  const db = await userDb();
  const { error } = await db.rpc("merge_contractors", { p_from: uuid.parse(fromId), p_into: uuid.parse(intoId) });
  if (error) return fail(error);
  revalidatePath("/contractors");
  return { ok: true, message: "Clients merged" };
}

export async function revealTaxIds(id: string): Promise<{ gstin: string | null; pan: string | null } | null> {
  const db = await userDb();
  const { data } = await db.rpc("contractor_tax_ids", { p_contractor: uuid.parse(id) });
  return (data as { gstin: string | null; pan: string | null } | null) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------------------------
const expenseSchema = z.object({
  category_id: uuid,
  expense_date: isoDate,
  title: z.string().trim().min(1, "What was this for?").max(200),
  amount: money,
  vendor: optionalText(160),
  payment_mode: mode,
  reference_no: optionalText(80),
  contractor_id: optionalId,
  ledger_id: optionalId,
  gst_rate: z.string().trim().regex(/^\d{1,2}(\.\d{1,3})?$/).optional().or(z.literal("")),
  gst_amount: money.optional().or(z.literal("")),
  notes: optionalText(2000),
  idempotency_key: z.string().min(8).max(120).optional(),
});

export async function saveExpense(id: string | null, _: unknown, form: FormData): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const parsed = expenseSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields", fieldErrors: errors(parsed.error) };
  const { error } = id
    ? await ctx.db.rpc("update_expense", { p_id: uuid.parse(id), p: { ...parsed.data, ledger_id: undefined } })
    : await ctx.db.rpc("create_expense", { p: { ...parsed.data, workspace_id: ctx.workspace.id } });
  if (error) return fail(error);
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  if (parsed.data.ledger_id) revalidatePath(`/ledgers/${parsed.data.ledger_id}`);
  return { ok: true, message: id ? "Expense updated" : "Expense saved" };
}

export async function voidExpense(id: string, reason: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("void_expense", { p_id: uuid.parse(id), p_reason: reason });
  if (error) return fail(error);
  revalidatePath("/expenses");
  revalidatePath("/ledgers", "layout");
  return { ok: true, message: "Expense voided" };
}

export async function addCategory(name: string): Promise<ActionResult<{ id: string }>> {
  const ctx = await getWorkspace();
  const parsed = z.string().trim().min(1).max(60).safeParse(name);
  if (!parsed.success) return { ok: false, error: "Enter a category name" };
  const { data, error } = await ctx.db.from("expense_categories").insert({ workspace_id: ctx.workspace.id, name: parsed.data }).select("id").single();
  if (error) return fail(error);
  revalidatePath("/expenses");
  return { ok: true, data: { id: data.id }, message: "Category added" };
}

// ---------------------------------------------------------------------------------------------
// Advances
// ---------------------------------------------------------------------------------------------
const advanceSchema = z.object({
  contractor_id: uuid,
  given_date: isoDate,
  amount: money,
  payment_mode: mode,
  reference_no: optionalText(80),
  purpose: optionalText(200),
  notes: optionalText(2000),
  expected_recovery_date: isoDate.optional().or(z.literal("")),
  ledger_id: optionalId,
  idempotency_key: z.string().min(8).max(120).optional(),
});

export async function createAdvance(_: unknown, form: FormData): Promise<ActionResult<{ id: string }>> {
  const ctx = await getWorkspace();
  const parsed = advanceSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields", fieldErrors: errors(parsed.error) };
  const { data, error } = await ctx.db.rpc("create_advance", { p: { ...parsed.data, workspace_id: ctx.workspace.id } });
  if (error) return fail(error);
  revalidatePath("/advances");
  revalidatePath("/dashboard");
  return { ok: true, data: { id: (data as { id: string }).id }, message: "Advance recorded" };
}

const allocationSchema = z.object({
  advance_id: uuid,
  kind: z.enum(["recovery", "adjustment"]),
  amount: money,
  alloc_date: isoDate,
  payment_mode: mode,
  bill_reference: optionalText(80),
  bill_transaction_id: optionalId,
  notes: optionalText(2000),
  idempotency_key: z.string().min(8).max(120).optional(),
});

export async function recordAllocation(_: unknown, form: FormData): Promise<ActionResult> {
  await requireUser();
  const parsed = allocationSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields", fieldErrors: errors(parsed.error) };
  const db = await userDb();
  const { error } = await db.rpc("record_advance_allocation", { p: parsed.data });
  if (error) return fail(error);
  revalidatePath(`/advances/${parsed.data.advance_id}`);
  revalidatePath("/advances");
  revalidatePath("/dashboard");
  return { ok: true, message: parsed.data.kind === "recovery" ? "Recovery recorded" : "Adjustment recorded" };
}

export async function voidAllocation(id: string, advanceId: string, reason: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("void_advance_allocation", { p_id: uuid.parse(id), p_reason: reason });
  if (error) return fail(error);
  revalidatePath(`/advances/${advanceId}`);
  return { ok: true, message: "Recovery voided" };
}

export async function voidAdvance(id: string, reason: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("void_advance", { p_id: uuid.parse(id), p_reason: reason });
  if (error) return fail(error);
  revalidatePath(`/advances/${id}`);
  revalidatePath("/advances");
  return { ok: true, message: "Advance voided" };
}

// ---------------------------------------------------------------------------------------------
// Personal & shared ledgers
// ---------------------------------------------------------------------------------------------
const sharedExpenseSchema = z.object({
  ledger_id: uuid,
  txn_date: isoDate,
  description: z.string().trim().min(1, "What was it for?").max(200),
  total_amount: money,
  split_method: z.enum(["equal", "exact", "percent", "shares"]),
  category: optionalText(60),
  payment_mode: mode,
  reference_no: optionalText(80),
  notes: optionalText(2000),
  payers: z.array(z.object({ participant_id: uuid, amount: money })).min(1, "Choose who paid"),
  shares: z.array(z.object({ participant_id: uuid, input: z.string().trim().max(20).optional() })).min(1, "Choose who shares it"),
  idempotency_key: z.string().min(8).max(120).optional(),
});

export type SharedExpenseInput = z.input<typeof sharedExpenseSchema>;

/** Shares are recomputed here from the method and inputs; the browser preview is never trusted. */
function buildSharedPayload(input: z.output<typeof sharedExpenseSchema>) {
  const total = toPaise(input.total_amount);
  const shares = computeShares(
    total,
    input.split_method as SplitMethod,
    input.shares.map((s) => ({ participantId: s.participant_id, input: s.input })),
  );
  return {
    ...input,
    shares: shares.map((s) => ({ participant_id: s.participantId, amount: toDecimal(s.amount), input: s.input })),
  };
}

export async function saveSharedExpense(correctingId: string | null, input: SharedExpenseInput): Promise<ActionResult> {
  await requireUser();
  const parsed = sharedExpenseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, fieldErrors: errors(parsed.error) };
  let payload;
  try {
    payload = buildSharedPayload(parsed.data);
  } catch (e) {
    return { ok: false, error: e instanceof MoneyError ? e.message : "Check the split" };
  }
  const db = await userDb();
  const { data, error } = correctingId
    ? await db.rpc("correct_shared_expense", { p_id: uuid.parse(correctingId), p: payload })
    : await db.rpc("create_shared_expense", { p: payload });
  if (error) return fail(error);
  revalidatePath(`/ledgers/${parsed.data.ledger_id}`);
  revalidatePath("/shared");
  const duplicate = (data as { duplicate?: boolean } | null)?.duplicate;
  return { ok: true, message: duplicate ? "Already saved" : correctingId ? "Expense corrected" : "Expense added" };
}

export async function voidSharedExpense(id: string, ledgerId: string, reason: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("void_shared_expense", { p_id: uuid.parse(id), p_reason: reason });
  if (error) return fail(error);
  revalidatePath(`/ledgers/${ledgerId}`);
  return { ok: true, message: "Expense removed from balances" };
}

const settlementSchema = z.object({
  ledger_id: uuid,
  from_participant_id: uuid,
  to_participant_id: uuid,
  amount: money,
  txn_date: isoDate,
  payment_mode: mode,
  reference_no: optionalText(80),
  notes: optionalText(2000),
  idempotency_key: z.string().min(8).max(120).optional(),
});

export async function recordRepayment(input: z.input<typeof settlementSchema>): Promise<ActionResult> {
  await requireUser();
  const parsed = settlementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, fieldErrors: errors(parsed.error) };
  const db = await userDb();
  const { error } = await db.rpc("record_settlement", { p: parsed.data });
  if (error) return fail(error);
  revalidatePath(`/ledgers/${parsed.data.ledger_id}`);
  return { ok: true, message: "Repayment recorded" };
}

export async function voidRepayment(id: string, ledgerId: string, reason: string): Promise<ActionResult> {
  const db = await userDb();
  const { error } = await db.rpc("void_settlement", { p_id: uuid.parse(id), p_reason: reason });
  if (error) return fail(error);
  revalidatePath(`/ledgers/${ledgerId}`);
  return { ok: true, message: "Repayment voided" };
}
