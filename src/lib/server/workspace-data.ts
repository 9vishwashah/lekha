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
  const entries = ledgers.map((l) => {
    const txns = byLedger.get(l.id) ?? [];
    if (l.ledger_type === "personal") return { ledger: l, statement: null, periodStatement: null, count: 0 };
    const ledger = { perspective: l.perspective as Perspective, opening_balance: l.opening_balance };
    return {
      ledger: l,
      statement: buildStatement(ledger, txns),
      periodStatement: buildStatement(ledger, txns, range),
      count: txns.filter((t) => t.status === "posted").length,
    };
  });
  const active = entries.filter((e) => e.ledger.status === "active");
  const period = aggregate(active.map((e) => e.periodStatement).filter(Boolean) as Statement<BalanceRow>[]);
  const now = aggregate(active.map((e) => e.statement).filter(Boolean) as Statement<BalanceRow>[]);
  return { entries, moneyIn: period.moneyIn, moneyOut: period.moneyOut, receivable: now.receivable, payable: now.payable, cashBalance: now.cashBalance };
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
