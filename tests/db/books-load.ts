import { as, type Db } from "./harness";
import type { BooksInput } from "@/lib/domain/books";

/** The rows src/lib/server/books.ts loads, read as a signed-in member, for computeBooks(). */
export async function loadBooksInput(db: Db, ws: string, who: string): Promise<BooksInput> {
  return as(db, who, async (q) => {
    const rows = <T>(sql: string) => q<T>(sql, [ws]);
    const iso = <T extends Record<string, unknown>>(x: T, ...keys: string[]) => {
      const out: Record<string, unknown> = { ...x };
      for (const k of keys) out[k] = (x[k] as Date).toISOString().slice(0, 10);
      return out as T;
    };
    const payers = await rows<{ shared_expense_id: string; participant_id: string; amount_paid: string }>("select p.* from public.shared_expense_payers p join public.shared_expenses e on e.id = p.shared_expense_id where e.workspace_id = $1");
    const shares = await rows<{ shared_expense_id: string; participant_id: string; share_amount: string }>("select s.* from public.shared_expense_shares s join public.shared_expenses e on e.id = s.shared_expense_id where e.workspace_id = $1");
    const allocations = await rows<Record<string, unknown> & { advance_id: string }>("select * from public.advance_allocations where workspace_id = $1");
    return {
      ledgers: await rows("select * from public.ledgers where workspace_id = $1"),
      txns: (await rows<BooksInput["txns"][number]>("select * from public.transactions where workspace_id = $1")).map((t) => iso(t, "txn_date")),
      tax: await rows("select * from public.transaction_tax_details where workspace_id = $1"),
      taxSettlements: await rows("select * from public.tax_settlements where workspace_id = $1"),
      invoices: (await rows<BooksInput["invoices"][number]>("select * from public.invoices where workspace_id = $1")).map((i) => iso(i, "invoice_date")),
      payments: await rows("select * from public.invoice_payments where workspace_id = $1"),
      expenses: (await rows<BooksInput["expenses"][number]>("select e.*, c.name as category, c.head as head from public.expenses e join public.expense_categories c on c.id = e.category_id where e.workspace_id = $1")).map((e) => iso(e, "expense_date")),
      advances: (await rows<BooksInput["advances"][number] & { id: string }>("select * from public.advances where workspace_id = $1")).map((a) => ({
        ...a,
        allocations: allocations.filter((x) => x.advance_id === a.id).map((x) => iso(x, "alloc_date")) as never,
      })),
      splitGroups: await rows("select * from public.split_groups where workspace_id = $1"),
      participants: await rows("select * from public.ledger_participants where workspace_id = $1"),
      sharedExpenses: (await rows<BooksInput["sharedExpenses"][number]>("select * from public.shared_expenses where workspace_id = $1")).map((e) => ({
        ...iso(e, "txn_date"),
        payers: payers.filter((x) => x.shared_expense_id === e.id),
        shares: shares.filter((x) => x.shared_expense_id === e.id),
      })),
      settlements: await rows("select * from public.settlements where workspace_id = $1"),
    } as BooksInput;
  });
}
