import "server-only";
import { anonDb } from "@/lib/supabase/server";
import type { StatementTxn } from "@/lib/reports";
import type { Perspective } from "@/lib/domain/ledger";

/** Shape returned by public.get_shared_ledger(): already filtered by the link's settings. */
export interface SharedPayload {
  ledger: {
    name: string;
    ledger_type: "basic" | "taxation" | "personal";
    perspective: Perspective | "personal";
    contractor_name: string | null;
    opening_balance: string | null;
    opening_balance_date: string | null;
    last_activity_at: string;
  };
  options: {
    show_balance: boolean;
    show_running_balance: boolean;
    show_tax: boolean;
    show_reference: boolean;
    show_counterparty: boolean;
  };
  transactions: (StatementTxn & { seq: number; date: string })[];
  participants: { key: number; name: string }[] | null;
  shared_expenses:
    | { date: string; description: string; total: string; method: string; category: string | null; created: string; payers: { key: number; amount: string }[]; shares: { key: number; amount: string }[] }[]
    | null;
  settlements: { date: string; amount: string; created: string; from: number; to: number }[] | null;
  /** Latest "this is right" from the person it was shared with (share links only). */
  acknowledgement?: { at: string; name: string | null; current: boolean } | null;
}

export const isTokenShape = (token: string) => /^[A-Za-z0-9_-]{32,128}$/.test(token);

/** An invitation page to return to after setup, or null. Nothing else is accepted as a return path. */
export const inviteReturnPath = (v: unknown) => (typeof v === "string" && v.startsWith("/invite/") && isTokenShape(v.slice(8)) ? v : null);

function normalise(data: unknown): SharedPayload {
  const payload = data as SharedPayload & { transactions: (Omit<StatementTxn, "txn_date" | "status"> & { date: string })[] };
  return {
    ...payload,
    // Public rows are always posted; normalise to the shared statement shape.
    transactions: payload.transactions.map((t) => ({ ...t, txn_date: t.date, status: "posted" as const })),
  };
}

export async function loadShared(token: string): Promise<SharedPayload | null> {
  if (!isTokenShape(token)) return null;
  const { data, error } = await anonDb().rpc("get_shared_ledger", { p_token: token });
  if (error || !data) return null;
  return normalise(data);
}

/** The ledger behind an open invitation, read-only (no tax details or references). */
export async function loadInvitationLedger(token: string): Promise<SharedPayload | null> {
  if (!isTokenShape(token)) return null;
  const { data, error } = await anonDb().rpc("get_invitation_ledger", { p_token: token });
  if (error || !data) return null;
  return normalise(data);
}

export async function sharedVersion(token: string): Promise<string | null> {
  if (!isTokenShape(token)) return null;
  const { data, error } = await anonDb().rpc("get_shared_ledger_version", { p_token: token });
  if (error || !data) return null;
  return data as string;
}

/** Converts the public personal-ledger payload into the records the split engine reads. */
export function sharedPersonalRecords(p: SharedPayload) {
  const participants = (p.participants ?? []).map((x) => ({ id: String(x.key), name: x.name }));
  const expenses = (p.shared_expenses ?? []).map((e, i) => ({
    id: `e${i}`,
    status: "posted" as const,
    txn_date: e.date,
    description: e.description,
    total_amount: e.total,
    payers: (e.payers ?? []).map((x) => ({ participant_id: String(x.key), amount_paid: x.amount })),
    shares: (e.shares ?? []).map((x) => ({ participant_id: String(x.key), share_amount: x.amount })),
  }));
  const settlements = (p.settlements ?? []).map((s, i) => ({
    id: `s${i}`,
    status: "posted" as const,
    txn_date: s.date,
    from_participant_id: String(s.from),
    to_participant_id: String(s.to),
    amount: s.amount,
  }));
  return { participants, expenses, settlements };
}
