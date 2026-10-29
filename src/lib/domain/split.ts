import { type Paise, MoneyError, sum, toPaise } from "./money";

/**
 * Personal & shared ledgers.
 *
 * One canonical record per shared expense: who paid how much, and each person's share.
 * Everyone's view is derived from the same records, so nothing is ever stored twice.
 *
 *   net(person) = paid − own share + repayments made − repayments received
 *
 * Positive net: others owe this person. Negative: this person owes others. Nets always sum to
 * zero. In a viewer's own books, a positive net is a receivable (debit to the other person's
 * account) and a negative net is a payable (credit to the other person's account).
 */
export type SplitMethod = "equal" | "exact" | "percent" | "shares";

export interface ShareInput {
  participantId: string;
  input?: string; // exact amount, percentage, or share units, depending on method
}

export interface ComputedShare {
  participantId: string;
  amount: Paise;
  input: string | null;
}

export class SplitError extends MoneyError {}

/** Integer weights for percent (×1000) and share units (×100). */
function weight(value: string | undefined, scale: bigint, label: string): bigint {
  const text = (value ?? "").trim();
  const decimals = scale === 1000n ? 3 : 2;
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`).exec(text);
  if (!match) throw new SplitError(`Enter a valid ${label}`);
  return BigInt(match[1]) * scale + BigInt(((match[2] ?? "") + "000").slice(0, decimals));
}

/**
 * Largest-remainder allocation: floors each proportional share, then hands leftover paise to the
 * largest fractional remainders (ties go to the earlier participant). Always sums to total.
 */
function allocate(total: Paise, weights: bigint[]): Paise[] {
  const totalWeight = sum(weights);
  if (totalWeight <= 0n) throw new SplitError("Shares must add up to more than zero");
  const floors = weights.map((w) => (total * w) / totalWeight);
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % totalWeight }));
  let leftover = total - sum(floors);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    floors[i] += 1n;
    leftover -= 1n;
  }
  return floors;
}

export function computeShares(total: Paise, method: SplitMethod, entries: ShareInput[]): ComputedShare[] {
  if (total <= 0n) throw new SplitError("Total must be greater than zero");
  if (entries.length === 0) throw new SplitError("Choose who shares this expense");
  const ids = new Set(entries.map((e) => e.participantId));
  if (ids.size !== entries.length) throw new SplitError("Each person can appear only once");

  switch (method) {
    case "equal": {
      const amounts = allocate(total, entries.map(() => 1n));
      return entries.map((e, i) => ({ participantId: e.participantId, amount: amounts[i], input: null }));
    }
    case "exact": {
      const amounts = entries.map((e) => toPaise(e.input ?? "0"));
      if (amounts.some((a) => a < 0n)) throw new SplitError("Shares cannot be negative");
      const diff = total - sum(amounts);
      if (diff !== 0n) {
        throw new SplitError(diff > 0n ? `Shares are short by ₹${fmt(diff)}` : `Shares are over by ₹${fmt(-diff)}`);
      }
      return entries.map((e, i) => ({ participantId: e.participantId, amount: amounts[i], input: null }));
    }
    case "percent": {
      const weights = entries.map((e) => weight(e.input, 1000n, "percentage"));
      if (sum(weights) !== 100_000n) throw new SplitError("Percentages must add up to 100");
      const amounts = allocate(total, weights);
      return entries.map((e, i) => ({ participantId: e.participantId, amount: amounts[i], input: e.input ?? null }));
    }
    case "shares": {
      const weights = entries.map((e) => weight(e.input, 100n, "number of shares"));
      const amounts = allocate(total, weights);
      return entries.map((e, i) => ({ participantId: e.participantId, amount: amounts[i], input: e.input ?? null }));
    }
  }
}

const fmt = (p: Paise) => (Number(p) / 100).toFixed(2);

// ---------------------------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------------------------
export interface SharedExpenseRecord {
  id: string;
  status: "posted" | "void";
  total_amount: string;
  payers: { participant_id: string; amount_paid: string }[];
  shares: { participant_id: string; share_amount: string }[];
}

export interface SettlementRecord {
  id: string;
  status: "posted" | "void";
  from_participant_id: string;
  to_participant_id: string;
  amount: string;
}

export interface ParticipantBalance {
  paid: Paise;
  share: Paise;
  repaid: Paise; // repayments this person made
  received: Paise; // repayments this person received
  net: Paise;
}

export function participantBalances(
  participantIds: string[],
  expenses: SharedExpenseRecord[],
  settlements: SettlementRecord[],
): Map<string, ParticipantBalance> {
  const map = new Map<string, ParticipantBalance>(
    participantIds.map((id) => [id, { paid: 0n, share: 0n, repaid: 0n, received: 0n, net: 0n }]),
  );
  const get = (id: string) => {
    const entry = map.get(id);
    if (!entry) throw new SplitError("Unknown participant");
    return entry;
  };
  for (const e of expenses) {
    if (e.status !== "posted") continue;
    for (const p of e.payers) get(p.participant_id).paid += toPaise(p.amount_paid);
    for (const s of e.shares) get(s.participant_id).share += toPaise(s.share_amount);
  }
  for (const s of settlements) {
    if (s.status !== "posted") continue;
    get(s.from_participant_id).repaid += toPaise(s.amount);
    get(s.to_participant_id).received += toPaise(s.amount);
  }
  for (const b of map.values()) b.net = b.paid - b.share + b.repaid - b.received;
  return map;
}

export interface Debt {
  from: string;
  to: string;
  amount: Paise;
}

/**
 * Who should pay whom to settle everything, with as few payments as practical.
 * Greedy largest-debtor to largest-creditor; deterministic for equal amounts.
 * For two people this is exactly the pairwise balance.
 */
export function simplifyDebts(balances: Map<string, ParticipantBalance>, order: string[]): Debt[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const byAmount = (a: [string, Paise], b: [string, Paise]) =>
    a[1] === b[1] ? (rank.get(a[0]) ?? 0) - (rank.get(b[0]) ?? 0) : a[1] > b[1] ? -1 : 1;
  const creditors: [string, Paise][] = [];
  const debtors: [string, Paise][] = [];
  for (const [id, b] of balances) {
    if (b.net > 0n) creditors.push([id, b.net]);
    else if (b.net < 0n) debtors.push([id, -b.net]);
  }
  const debts: Debt[] = [];
  while (creditors.length && debtors.length) {
    creditors.sort(byAmount);
    debtors.sort(byAmount);
    const c = creditors[0];
    const d = debtors[0];
    const amount = c[1] < d[1] ? c[1] : d[1];
    debts.push({ from: d[0], to: c[0], amount });
    c[1] -= amount;
    d[1] -= amount;
    if (c[1] === 0n) creditors.shift();
    if (d[1] === 0n) debtors.shift();
  }
  return debts;
}

/** Largest repayment allowed from one person to another (mirrors record_settlement). */
export function maxRepayment(balances: Map<string, ParticipantBalance>, from: string, to: string): Paise {
  const owes = -(balances.get(from)?.net ?? 0n);
  const owed = balances.get(to)?.net ?? 0n;
  if (owes <= 0n || owed <= 0n) return 0n;
  return owes < owed ? owes : owed;
}

/** One person's view of the ledger. */
export function viewerSummary(
  viewerId: string,
  balances: Map<string, ParticipantBalance>,
  debts: Debt[],
  expenses: SharedExpenseRecord[],
) {
  const me = balances.get(viewerId) ?? { paid: 0n, share: 0n, repaid: 0n, received: 0n, net: 0n };
  const posted = expenses.filter((e) => e.status === "posted");
  return {
    totalShared: sum(posted.map((e) => toPaise(e.total_amount))),
    youPaid: me.paid,
    yourShare: me.share,
    net: me.net,
    youOwe: debts.filter((d) => d.from === viewerId),
    owedToYou: debts.filter((d) => d.to === viewerId),
  };
}

/** Effect of one expense on one person: positive means they lent, negative means they borrowed. */
export function expenseEffect(expense: SharedExpenseRecord, participantId: string) {
  const paid = sum(expense.payers.filter((p) => p.participant_id === participantId).map((p) => toPaise(p.amount_paid)));
  const share = sum(expense.shares.filter((s) => s.participant_id === participantId).map((s) => toPaise(s.share_amount)));
  return { paid, share, effect: paid - share };
}
