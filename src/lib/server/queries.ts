import "server-only";
import { notFound } from "next/navigation";
import type { Db } from "@/lib/supabase/server";
import type {
  Collaborator,
  Contractor,
  Ledger,
  Participant,
  SharedExpense,
  Settlement,
  TaxDetail,
  Txn,
} from "@/lib/types";

const PAGE = 1000;

export const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** PostgREST caps responses (1000 rows by default), so financial reads always page through. */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

export const LEDGER_COLUMNS =
  "id, workspace_id, contractor_id, name, ledger_type, perspective, reference_no, opening_balance, opening_balance_date, description, notes, status, gst_mode, color, owner_user_id, last_activity_at, created_at";

export const TXN_COLUMNS =
  "id, ledger_id, seq, voucher_no, txn_date, direction, amount, kind, is_cash, affects_party, description, counterparty, payment_mode, reference_no, notes, status, reversal_of, void_reason, created_by, created_via, updated_by, created_at, updated_at, import_batch_id";

const BALANCE_COLUMNS = "ledger_id, seq, txn_date, direction, amount, kind, is_cash, affects_party, status";

export const CONTRACTOR_COLUMNS =
  "id, workspace_id, name, business_name, phone, email, address, notes, is_active, merged_into, kind, linked_user_id, created_at";

export type BalanceRow = Pick<Txn, "ledger_id" | "seq" | "txn_date" | "direction" | "amount" | "kind" | "is_cash" | "affects_party" | "status">;

export async function listLedgers(db: Db, workspaceId: string) {
  const { data, error } = await db
    .from("ledgers")
    .select(`${LEDGER_COLUMNS}, contractor:contractors(id, name)`)
    .eq("workspace_id", workspaceId)
    .order("last_activity_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as (Ledger & { contractor: { id: string; name: string } | null })[];
}

/** Minimal rows for computing every ledger balance in a workspace. */
export async function workspaceBalanceRows(db: Db, workspaceId: string) {
  return fetchAll<BalanceRow>((from, to) =>
    db.from("transactions").select(BALANCE_COLUMNS).eq("workspace_id", workspaceId).order("id").range(from, to),
  );
}

export async function getLedger(db: Db, id: string) {
  if (!isUuid(id)) notFound();
  const { data, error } = await db
    .from("ledgers")
    .select(`${LEDGER_COLUMNS}, contractor:contractors(id, name, business_name, phone)`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) notFound();
  return data as unknown as Ledger & {
    contractor: { id: string; name: string; business_name: string | null; phone: string | null } | null;
  };
}

export async function getLedgerTxns(db: Db, ledgerId: string) {
  if (!isUuid(ledgerId)) return [];
  return fetchAll<Txn>((from, to) =>
    db.from("transactions").select(TXN_COLUMNS).eq("ledger_id", ledgerId).order("txn_date").order("seq").range(from, to),
  );
}

/** Tax rows are filtered by RLS: collaborators without tax permission simply receive none. */
export async function getLedgerTax(db: Db, ledgerId: string) {
  if (!isUuid(ledgerId)) return new Map<string, TaxDetail>();
  const rows = await fetchAll<TaxDetail>((from, to) =>
    db.from("transaction_tax_details").select("*").eq("ledger_id", ledgerId).order("transaction_id").range(from, to),
  );
  return new Map(rows.map((r) => [r.transaction_id, r]));
}

export async function getTaxSettlements(db: Db, ledgerIds: string[]) {
  if (!ledgerIds.length) return [];
  return fetchAll<{ transaction_id: string; ledger_id: string; tax_type: "gst" | "tds" | "other"; account_mapping: string; period_month: string; challan_no: string | null; settlement_status: string }>(
    (from, to) => db.from("tax_settlements").select("*").in("ledger_id", ledgerIds).order("transaction_id").range(from, to),
  );
}

/** Ids of entries cancelled by a posted reversal. */
export function reversedIds(txns: Pick<Txn, "reversal_of" | "status">[]) {
  return new Set(txns.filter((t) => t.reversal_of && t.status === "posted").map((t) => t.reversal_of!));
}

export async function getPersonalLedger(db: Db, ledgerId: string) {
  if (!isUuid(ledgerId)) return { participants: [] as Participant[], expenses: [] as SharedExpense[], settlements: [] as Settlement[] };
  const [participants, expenses, payers, shares, settlements] = await Promise.all([
    db.from("ledger_participants").select("id, ledger_id, display_name, user_id, contractor_id, position").eq("ledger_id", ledgerId).order("position"),
    fetchAll<Omit<SharedExpense, "payers" | "shares">>((from, to) =>
      db.from("shared_expenses").select("*").eq("ledger_id", ledgerId).order("txn_date").order("created_at").range(from, to),
    ),
    fetchAll<{ shared_expense_id: string; participant_id: string; amount_paid: string }>((from, to) =>
      db.from("shared_expense_payers").select("shared_expense_id, participant_id, amount_paid").eq("ledger_id", ledgerId).range(from, to),
    ),
    fetchAll<{ shared_expense_id: string; participant_id: string; share_amount: string; share_input: string | null }>((from, to) =>
      db.from("shared_expense_shares").select("shared_expense_id, participant_id, share_amount, share_input").eq("ledger_id", ledgerId).range(from, to),
    ),
    fetchAll<Settlement>((from, to) =>
      db.from("settlements").select("*").eq("ledger_id", ledgerId).order("txn_date").order("created_at").range(from, to),
    ),
  ]);
  const group = <T extends { shared_expense_id: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const r of rows) map.set(r.shared_expense_id, [...(map.get(r.shared_expense_id) ?? []), r]);
    return map;
  };
  // Postgres numerics come back as JSON numbers; the app (and its forms) treat money as text.
  const t = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const payerMap = group(payers.map((p) => ({ ...p, amount_paid: t(p.amount_paid)! })));
  const shareMap = group(shares.map((s) => ({ ...s, share_amount: t(s.share_amount)!, share_input: t(s.share_input) })));
  return {
    participants: (participants.data ?? []) as Participant[],
    expenses: expenses.map((e) => ({ ...e, total_amount: t(e.total_amount)!, payers: payerMap.get(e.id) ?? [], shares: shareMap.get(e.id) ?? [] })) as SharedExpense[],
    settlements: settlements.map((s) => ({ ...s, amount: t(s.amount)! })),
  };
}

export async function getCollaborators(db: Db, ledgerId: string) {
  const { data } = await db.from("ledger_collaborators").select("*").eq("ledger_id", ledgerId).order("created_at");
  return (data ?? []) as Collaborator[];
}

export async function listContractors(db: Db, workspaceId: string) {
  const { data, error } = await db
    .from("contractors")
    .select(CONTRACTOR_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Contractor[];
}

/** Display names for user ids seen in a workspace or ledger (members and collaborators). */
export async function peopleNames(db: Db, workspaceId: string | null, ledgerId?: string) {
  const names = new Map<string, string>();
  // Without a workspace id, RLS limits members to the caller's own workspaces.
  let membersQuery = db.from("workspace_members").select("user_id, display_name, email");
  if (workspaceId) membersQuery = membersQuery.eq("workspace_id", workspaceId);
  const [{ data: members }, collabs] = await Promise.all([
    membersQuery,
    ledgerId && isUuid(ledgerId)
      ? db.from("ledger_collaborators").select("user_id, display_name, email").eq("ledger_id", ledgerId)
      : Promise.resolve({ data: [] }),
  ]);
  for (const m of members ?? []) names.set(m.user_id, m.display_name || m.email || "Member");
  for (const c of (collabs.data ?? []) as { user_id: string; display_name: string | null; email: string | null }[]) {
    if (!names.has(c.user_id)) names.set(c.user_id, c.display_name || c.email || "Collaborator");
  }
  return names;
}
