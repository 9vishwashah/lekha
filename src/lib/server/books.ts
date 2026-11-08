import "server-only";
import type { Db } from "@/lib/supabase/server";
import { type BooksInput, computeBooks } from "@/lib/domain/books";
import { fetchAll, listLedgers } from "./queries";
import { listInvoices, listPayments } from "./invoices";
import type { SharedAccountRows } from "./people";

/**
 * Everything the books are worked out from, in one parallel round. Shared accounts come in from
 * the caller, who has already loaded them for the people figures.
 */
export async function loadBooks(db: Db, workspaceId: string, shared: SharedAccountRows) {
  const eq = "workspace_id";
  const [ledgers, txns, tax, taxSettlements, invoices, payments, expenses, categories, advances, splitGroups] = await Promise.all([
    listLedgers(db, workspaceId),
    fetchAll<BooksInput["txns"][number]>((f, t) =>
      db.from("transactions").select("id, ledger_id, txn_date, direction, amount, kind, is_cash, affects_party, status, reversal_of, wallet_ledger_id, nature, voucher_no, description, reference_no").eq(eq, workspaceId).order("id").range(f, t),
    ),
    fetchAll<BooksInput["tax"][number]>((f, t) => db.from("transaction_tax_details").select("transaction_id, taxable_amount, gst_amount, tds_amount").eq(eq, workspaceId).order("transaction_id").range(f, t)),
    fetchAll<BooksInput["taxSettlements"][number]>((f, t) => db.from("tax_settlements").select("transaction_id, tax_type").eq(eq, workspaceId).order("transaction_id").range(f, t)),
    listInvoices(db, workspaceId),
    listPayments(db, workspaceId),
    fetchAll<Omit<BooksInput["expenses"][number], "category"> & { category_id: string }>((f, t) =>
      db.from("expenses").select("amount, expense_date, status, transaction_id, split_group_id, category_id").eq(eq, workspaceId).order("id").range(f, t),
    ),
    fetchAll<{ id: string; name: string }>((f, t) => db.from("expense_categories").select("id, name").eq(eq, workspaceId).order("id").range(f, t)),
    fetchAll<BooksInput["advances"][number]>((f, t) =>
      db.from("advances").select("id, contractor_id, purpose, ledger_id, amount, status, allocations:advance_allocations(kind, amount, status, alloc_date, transaction_id)").eq(eq, workspaceId).order("id").range(f, t),
    ),
    fetchAll<BooksInput["splitGroups"][number]>((f, t) => db.from("split_groups").select("total_amount, paid_by_contractor_id, transaction_id, status").eq(eq, workspaceId).order("id").range(f, t)),
  ]);

  const names = new Map(categories.map((c) => [c.id, c.name]));
  const here = new Set(ledgers.map((l) => l.id));
  const inHere = <T extends { ledger_id: string }>(rows: T[]) => rows.filter((r) => here.has(r.ledger_id));
  const payers = new Map<string, { participant_id: string; amount_paid: string }[]>();
  for (const p of shared.payers) payers.set(p.shared_expense_id, [...(payers.get(p.shared_expense_id) ?? []), p]);
  const shares = new Map<string, { participant_id: string; share_amount: string }[]>();
  for (const s of shared.shares) shares.set(s.shared_expense_id, [...(shares.get(s.shared_expense_id) ?? []), s]);

  return computeBooks({
    ledgers,
    txns,
    tax,
    taxSettlements,
    invoices,
    payments,
    expenses: expenses.map((e) => ({ ...e, category: names.get(e.category_id) ?? "Expenses" })),
    advances,
    splitGroups,
    participants: inHere(shared.participants),
    sharedExpenses: inHere(shared.expenses).map((e) => ({ ...e, payers: payers.get(e.id) ?? [], shares: shares.get(e.id) ?? [] })),
    settlements: inHere(shared.settlements),
  });
}
