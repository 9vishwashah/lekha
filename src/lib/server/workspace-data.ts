import "server-only";
import type { Db } from "@/lib/supabase/server";
import { type DateRange, type Perspective, type Statement, aggregate, buildStatement } from "@/lib/domain/ledger";
import { type AdvancePosition, advancePosition } from "@/lib/domain/advances";
import { type Paise, sum, toPaise } from "@/lib/domain/money";
import { type BalanceRow, fetchAll, listLedgers, workspaceBalanceRows } from "./queries";

/**
 * Workspace-wide figures for the dashboard, ledger list and reports. All balances come from
 * buildStatement() over the underlying entries; nothing here is stored or hand-maintained.
 */
export async function ledgerBalances(db: Db, workspaceId: string, range: DateRange = {}) {
  const [ledgers, rows] = await Promise.all([listLedgers(db, workspaceId), workspaceBalanceRows(db, workspaceId)]);
  const byLedger = new Map<string, BalanceRow[]>();
  for (const r of rows) {
    const list = byLedger.get(r.ledger_id);
    if (list) list.push(r);
    else byLedger.set(r.ledger_id, [r]);
  }
  // Money on a party ledger that went through a wallet moves that wallet's balance too. It is one
  // entry, so the totals below count it once, on the party ledger's side.
  const passing = rows.filter((r) => r.wallet_ledger_id && r.status === "posted" && r.is_cash);
  const through = new Map<string, BalanceRow[]>();
  for (const r of passing) through.set(r.wallet_ledger_id!, [...(through.get(r.wallet_ledger_id!) ?? []), r]);
  const entries = ledgers.map((l) => {
    const own = byLedger.get(l.id) ?? [];
    const txns = [...own, ...(through.get(l.id) ?? [])];
    if (l.ledger_type === "personal") return { ledger: l, statement: null, periodStatement: null, count: 0 };
    const ledger = { perspective: l.perspective as Perspective, opening_balance: l.opening_balance };
    return {
      ledger: l,
      statement: buildStatement(ledger, txns),
      periodStatement: buildStatement(ledger, txns, range),
      count: own.filter((t) => t.status === "posted").length,
    };
  });
  const active = entries.filter((e) => e.ledger.status === "active");
  const period = aggregate(active.map((e) => e.periodStatement).filter(Boolean) as Statement<BalanceRow>[]);
  const now = aggregate(active.map((e) => e.statement).filter(Boolean) as Statement<BalanceRow>[]);
  // Moving your own money between wallets is neither in nor out.
  const inPeriod = (r: BalanceRow) => (!range.from || r.txn_date >= range.from) && (!range.to || r.txn_date <= range.to);
  const liveLedgers = new Set(active.map((e) => e.ledger.id));
  const twice = passing.filter((r) => inPeriod(r) && liveLedgers.has(r.wallet_ledger_id!) && liveLedgers.has(r.ledger_id));
  const transfers = rows.filter((r) => r.nature === "transfer" && r.status === "posted" && inPeriod(r) && liveLedgers.has(r.ledger_id));
  const drop = (direction: "in" | "out") => sum([...twice, ...transfers].filter((r) => r.direction === direction).map((r) => toPaise(r.amount)));
  return { entries, moneyIn: period.moneyIn - drop("in"), moneyOut: period.moneyOut - drop("out"), receivable: now.receivable, payable: now.payable, cashBalance: now.cashBalance };
}

export interface AdvanceRow {
  id: string;
  contractor_id: string;
  ledger_id: string | null;
  given_date: string;
  amount: string;
  status: "active" | "void";
  purpose: string | null;
  expected_recovery_date: string | null;
  payment_mode: string | null;
  reference_no: string | null;
  contractor: { id: string; name: string } | null;
  allocations: { id: string; kind: "recovery" | "adjustment"; amount: string; status: "active" | "void"; alloc_date: string; bill_reference: string | null; notes: string | null; void_reason: string | null; created_at: string }[];
}

export async function advancesWithPositions(db: Db, workspaceId: string | null, today: string) {
  const rows = await fetchAll<AdvanceRow>((from, to) => {
    // Without a workspace id, RLS limits rows to the caller's own workspaces.
    const base = db
      .from("advances")
      .select(
        "id, contractor_id, ledger_id, given_date, amount, status, purpose, expected_recovery_date, payment_mode, reference_no, contractor:contractors(id, name), allocations:advance_allocations(id, kind, amount, status, alloc_date, bill_reference, notes, void_reason, created_at)",
      );
    return (workspaceId ? base.eq("workspace_id", workspaceId) : base).order("given_date", { ascending: false }).range(from, to);
  });
  return rows.map((a) => ({ ...a, position: advancePosition(a, a.allocations, today) as AdvancePosition }));
}

export async function expenseTotals(db: Db, workspaceId: string, range: DateRange) {
  const rows = await fetchAll<{ amount: string; category_id: string }>((from, to) => {
    let query = db
      .from("expenses")
      .select("id, amount, expense_date, category_id, status")
      .eq("workspace_id", workspaceId)
      .eq("status", "active");
    if (range.from) query = query.gte("expense_date", range.from);
    if (range.to) query = query.lte("expense_date", range.to);
    return query.order("id").range(from, to);
  });
  const byCategory = new Map<string, Paise>();
  for (const r of rows) byCategory.set(r.category_id, (byCategory.get(r.category_id) ?? 0n) + toPaise(r.amount));
  return { total: sum(rows.map((r) => toPaise(r.amount))), count: rows.length, byCategory };
}
