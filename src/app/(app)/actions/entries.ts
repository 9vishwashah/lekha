"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspace } from "@/lib/server/context";
import { type ActionResult, fail } from "@/lib/server/errors";
import { toDecimal, toPaise } from "@/lib/domain/money";

/**
 * The entries the Universal Entry Composer adds on top of the existing expense, payment and invoice
 * actions. Each is one database call that writes both sides of the entry together.
 */
const uuid = z.string().uuid();
const money = z
  .string()
  .trim()
  .transform((s) => s.replace(/,/g, ""))
  .pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 1500 or 1500.50"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");
const text = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const key = z.string().min(8).max(120);

function refresh() {
  revalidatePath("/dashboard");
  revalidatePath("/books");
  revalidatePath("/expenses");
  revalidatePath("/ledgers", "layout");
  revalidatePath("/contractors", "layout");
}

const billSchema = z.object({ contractor_id: uuid, amount: money, txn_date: isoDate, description: text(200), idempotency_key: key });

/** A bill on a client with no money moving: income now, owed until paid. */
export async function recordClientBill(input: z.input<typeof billSchema>): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const parsed = billSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const { error } = await ctx.db.rpc("record_client_bill", { p: { ...parsed.data, workspace_id: ctx.workspace.id } });
  if (error) return fail(error);
  refresh();
  return { ok: true, message: "Bill recorded" };
}

const paidForMeSchema = z.object({
  contractor_id: uuid,
  amount: money,
  your_share: money,
  category_id: uuid,
  title: z.string().trim().min(1, "What was it for?").max(200),
  expense_date: isoDate,
  idempotency_key: key,
});

/** Someone else paid; your part is your cost and you owe it to them. Their own part stays theirs. */
export async function recordPaidForMe(input: z.input<typeof paidForMeSchema>): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const parsed = paidForMeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const total = toPaise(parsed.data.amount);
  const yours = toPaise(parsed.data.your_share);
  if (yours <= 0n || yours > total) return { ok: false, error: "Your share must be more than zero and no more than the total" };
  const { contractor_id, ...rest } = parsed.data;
  const { error } = await ctx.db.rpc("create_split_expense", {
    p: { ...rest, workspace_id: ctx.workspace.id, paid_by_contractor_id: contractor_id, people: [{ contractor_id, amount: toDecimal(total - yours) }] },
  });
  if (error) return fail(error);
  refresh();
  return { ok: true, message: "Recorded what you owe" };
}

const partySchema = z.object({ from_contractor_id: uuid, to_contractor_id: uuid, amount: money, txn_date: isoDate, notes: text(500), idempotency_key: key });

/** One person pays another on your behalf: both balances move, none of your money does. */
export async function recordPartyTransfer(input: z.input<typeof partySchema>): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const parsed = partySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const { error } = await ctx.db.rpc("record_party_transfer", { p: { ...parsed.data, workspace_id: ctx.workspace.id } });
  if (error) return fail(error);
  refresh();
  return { ok: true, message: "Settled between them" };
}

const transferSchema = z.object({ from_ledger_id: uuid, to_ledger_id: uuid, amount: money, txn_date: isoDate, description: text(200), idempotency_key: key });

/** Between your own wallets. Neither income nor cost. */
export async function recordTransfer(input: z.input<typeof transferSchema>): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const { error } = await ctx.db.rpc("record_transfer", { p: { ...parsed.data, workspace_id: ctx.workspace.id } });
  if (error) return fail(error);
  refresh();
  return { ok: true, message: "Transfer recorded" };
}

export async function deleteTransfer(transferId: string): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const { error } = await ctx.db.rpc("delete_transfer", { p_transfer: uuid.parse(transferId) });
  if (error) return fail(error);
  refresh();
  return { ok: true, message: "Transfer deleted" };
}
