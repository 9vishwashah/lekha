import "server-only";
import type { Db } from "@/lib/supabase/server";
import type { Paise } from "@/lib/domain/money";
import { toPaise } from "@/lib/domain/money";
import { participantBalances, simplifyDebts, type SharedExpenseRecord } from "@/lib/domain/split";
import { fetchAll } from "./queries";
import type { ledgerBalances } from "./workspace-data";

/**
 * Who owes you and whom you owe, per client, across every kind of ledger:
 *   - party ledgers: the ledger's closing balance (positive = they owe you)
 *   - shared accounts: the settle-up amounts between you and that person
 * Plus your own position in shared accounts other people invited you to (they are not clients
 * in your workspace, so they count towards the totals only).
 *
 * Cash-book ledgers are not debts and never appear here.
 */
export interface PersonPosition {
  owesYou: Paise;
  youOwe: Paise;
  sources: { ledgerId: string; ledgerName: string; kind: "party" | "shared" | "invoice"; amount: Paise; external?: boolean }[]; // + they owe you, − you owe
}

interface ParticipantRow {
  id: string;
  ledger_id: string;
  workspace_id: string;
  contractor_id: string | null;
  user_id: string | null;
  position: number;
  display_name: string;
}

/** One parallel round. RLS limits every table to ledgers the caller can see. */
export async function loadSharedAccountRows(db: Db) {
  const [participants, expenses, payers, shares, settlements, ledgers] = await Promise.all([
    fetchAll<ParticipantRow>((f, t) =>
      db.from("ledger_participants").select("id, ledger_id, workspace_id, contractor_id, user_id, position, display_name").order("id").range(f, t),
    ),
    fetchAll<{ id: string; ledger_id: string; status: "posted" | "void"; total_amount: string; txn_date: string; description: string; category: string | null; split_group_id: string | null }>((f, t) =>
      db.from("shared_expenses").select("id, ledger_id, status, total_amount, txn_date, description, category, split_group_id").order("id").range(f, t),
    ),
    fetchAll<{ shared_expense_id: string; participant_id: string; amount_paid: string }>((f, t) =>
      db.from("shared_expense_payers").select("shared_expense_id, participant_id, amount_paid").order("shared_expense_id").range(f, t),
    ),
    fetchAll<{ shared_expense_id: string; participant_id: string; share_amount: string }>((f, t) =>
      db.from("shared_expense_shares").select("shared_expense_id, participant_id, share_amount").order("shared_expense_id").range(f, t),
    ),
    fetchAll<{ id: string; ledger_id: string; status: "posted" | "void"; from_participant_id: string; to_participant_id: string; amount: string; transaction_id: string | null }>((f, t) =>
      db.from("settlements").select("id, ledger_id, status, from_participant_id, to_participant_id, amount, transaction_id").order("id").range(f, t),
    ),
    fetchAll<{ id: string; name: string; status: string; workspace_id: string; is_direct: boolean; contractor_id: string | null }>((f, t) =>
      db.from("ledgers").select("id, name, status, workspace_id, is_direct, contractor_id").eq("ledger_type", "personal").order("id").range(f, t),
    ),
  ]);
  return { participants, expenses, payers, shares, settlements, ledgers };
}

export type SharedAccountRows = Awaited<ReturnType<typeof loadSharedAccountRows>>;

/** Debts between the viewer and everyone else, per shared account. */
export function sharedAccountDebts(rows: SharedAccountRows, userId: string) {
  const group = <T extends { ledger_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) {
      const arr = m.get(x.ledger_id);
      if (arr) arr.push(x);
      else m.set(x.ledger_id, [x]);
    }
    return m;
  };
  const expenseLedger = new Map(rows.expenses.map((e) => [e.id, e.ledger_id]));
  const payersBy = new Map<string, { participant_id: string; amount_paid: string }[]>();
  for (const p of rows.payers) {
    const list = payersBy.get(p.shared_expense_id);
    if (list) list.push(p);
    else payersBy.set(p.shared_expense_id, [p]);
  }
  const sharesBy = new Map<string, { participant_id: string; share_amount: string }[]>();
  for (const s of rows.shares) {
    const list = sharesBy.get(s.shared_expense_id);
    if (list) list.push(s);
    else sharesBy.set(s.shared_expense_id, [s]);
  }
  const people = group(rows.participants);
  const expenses = group(rows.expenses.filter((e) => expenseLedger.has(e.id)));
  const settlements = group(rows.settlements);

  return rows.ledgers
    .filter((l) => l.status === "active")
    .map((l) => {
      const ps = (people.get(l.id) ?? []).sort((a, b) => a.position - b.position);
      // A direct account is between the business and the client, so any teammate sees the business's side.
      const me = ps.find((p) => p.user_id === userId) ?? (l.is_direct ? ps[0] : undefined);
      const records: SharedExpenseRecord[] = (expenses.get(l.id) ?? []).map((e) => ({
        id: e.id,
        status: e.status,
        total_amount: e.total_amount,
        payers: payersBy.get(e.id) ?? [],
        shares: sharesBy.get(e.id) ?? [],
      }));
      const ids = ps.map((p) => p.id);
      const balances = participantBalances(ids, records, settlements.get(l.id) ?? []);
      const debts = me ? simplifyDebts(balances, ids).filter((d) => d.from === me.id || d.to === me.id) : [];
      return {
        ledger: l,
        me,
        owner: ps[0],
        lines: debts.map((d) => {
          const other = ps.find((p) => p.id === (d.from === me!.id ? d.to : d.from))!;
          return { other, amount: d.from === me!.id ? -d.amount : d.amount }; // + they owe you
        }),
      };
    })
    .filter((x) => x.me);
}

interface InvoiceDebt {
  id: string;
  invoice_no: string | null;
  contractor_id: string | null;
  ledger_id: string | null;
  transaction_id: string | null;
  status: string;
  invoice_type: string;
  grand_total: string;
  amount_received: string;
}

/**
 * One figure per person. Someone who owes you on a ledger and is owed on a shared account is one
 * balance, the same one their card shows, not a debtor and a creditor at once.
 *
 * An invoice that isn't on a party ledger counts here on its own; one that is, counts through that
 * ledger. Shared accounts someone else runs land on the card you hold for that person when there
 * is one, because linking makes one for you.
 */
export function peoplePositions(
  workspaceId: string,
  userId: string,
  balances: Awaited<ReturnType<typeof ledgerBalances>>,
  rows: SharedAccountRows,
  invoices: InvoiceDebt[] = [],
  clients: { id: string; linked_user_id: string | null }[] = [],
) {
  const byClient = new Map<string, PersonPosition>();
  const add = (clientId: string, src: PersonPosition["sources"][number]) => {
    const p = byClient.get(clientId) ?? { owesYou: 0n, youOwe: 0n, sources: [] };
    if (src.amount > 0n) p.owesYou += src.amount;
    else p.youOwe += -src.amount;
    p.sources.push(src);
    byClient.set(clientId, p);
  };

  for (const e of balances.entries) {
    if (e.ledger.status !== "active" || e.ledger.perspective !== "party" || !e.ledger.contractor_id || !e.statement) continue;
    if (e.statement.closing !== 0n) add(e.ledger.contractor_id, { ledgerId: e.ledger.id, ledgerName: e.ledger.name, kind: "party", amount: e.statement.closing });
  }

  const partyLedgers = new Set(balances.entries.filter((e) => e.ledger.perspective === "party").map((e) => e.ledger.id));
  let looseInvoices = 0n; // invoices with no client record to put them on
  for (const i of invoices) {
    if (i.status !== "issued" || i.invoice_type === "proforma") continue;
    if (i.transaction_id && i.ledger_id && partyLedgers.has(i.ledger_id)) continue;
    const due = toPaise(i.grand_total) - toPaise(i.amount_received);
    if (due === 0n) continue;
    if (i.contractor_id) add(i.contractor_id, { ledgerId: i.id, ledgerName: `Invoice ${i.invoice_no ?? ""}`.trim(), kind: "invoice", amount: due });
    else looseInvoices += due;
  }

  const cardFor = new Map(clients.filter((c) => c.linked_user_id).map((c) => [c.linked_user_id!, c.id]));

  let sharedOwesYou = 0n;
  let sharedYouOwe = 0n;
  for (const acct of sharedAccountDebts(rows, userId)) {
    for (const line of acct.lines) {
      if (acct.ledger.workspace_id === workspaceId && line.other.contractor_id) {
        add(line.other.contractor_id, { ledgerId: acct.ledger.id, ledgerName: acct.ledger.name, kind: "shared", amount: line.amount });
      } else if (acct.ledger.workspace_id !== workspaceId && acct.me!.position !== 0) {
        // Someone else's shared account you were invited to.
        const card = line.other.user_id ? cardFor.get(line.other.user_id) : undefined;
        if (card) add(card, { ledgerId: acct.ledger.id, ledgerName: acct.ledger.name, kind: "shared", amount: line.amount, external: true });
        else if (line.amount > 0n) sharedOwesYou += line.amount;
        else sharedYouOwe += -line.amount;
      }
    }
  }

  const nets = [...byClient.values()].map((p) => p.owesYou - p.youOwe);
  const owing = nets.filter((n) => n > 0n);
  const owed = nets.filter((n) => n < 0n);
  const owesYou = sharedOwesYou + (looseInvoices > 0n ? looseInvoices : 0n) + owing.reduce((a, n) => a + n, 0n);
  const youOwe = sharedYouOwe + (looseInvoices < 0n ? -looseInvoices : 0n) - owed.reduce((a, n) => a + n, 0n);
  const fromShared = [...byClient.values()].flatMap((p) => p.sources).filter((s) => s.kind === "shared");
  return {
    byClient,
    owesYou,
    youOwe,
    peopleOwingYou: owing.length + (sharedOwesYou > 0n ? 1 : 0),
    peopleYouOwe: owed.length + (sharedYouOwe > 0n ? 1 : 0),
    invitedOwesYou: sharedOwesYou,
    invitedYouOwe: sharedYouOwe,
    sharedIncluded: fromShared.length > 0 || sharedOwesYou + sharedYouOwe > 0n,
  };
}

export const net = (p: PersonPosition | undefined): Paise => (p ? p.owesYou - p.youOwe : 0n);

/** What stands in accounts the other person runs: theirs to keep, so outside your own books. */
export const externalNet = (p: PersonPosition | undefined): Paise =>
  (p?.sources ?? []).filter((s) => s.external).reduce((total, s) => total + s.amount, 0n);
