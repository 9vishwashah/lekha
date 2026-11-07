import { type Paise, sum, toPaise } from "./money";
import { expenseEffect, participantBalances, simplifyDebts } from "./split";

/**
 * The workspace's books, derived from what was recorded. Nothing here is stored.
 *
 *   Assets = Liabilities + Capital + Profit & Loss + Uncategorised
 *
 * Every figure is worked out on its own. Profit comes from income and costs, never as whatever
 * makes the two sides meet, so `difference` is a real check: it is zero because each event was
 * counted on both sides, and anything else is a fault to look at, not something to hide.
 *
 * Accrual basis: an invoice is income when issued, a bill is a cost when received, whether or not
 * money has moved. GST and TDS are never income or cost: they belong to the Government.
 *
 * Where each event lands:
 *   Invoice issued      debtor +grand total    income +before tax   GST payable +tax
 *   Bill received       creditor +net          cost +before tax     GST credit +gst   TDS payable +tds
 *   Bill raised         debtor +net            income +before tax   GST payable +gst  TDS receivable +tds
 *   Expense             cash −                 cost +
 *   Advance             cash −                 advances + (in a party ledger: that party's balance +)
 *   Your share, split   cash − all you paid    debtor + their part  cost + your part
 *   Tax paid            cash −                 GST or TDS payable −
 *   Wallet entry        cash ±                 what it says it was, else uncategorised
 *   Opening balance     cash or debtor ±       capital ±
 *
 * Cash that moved without naming a wallet still moved, so it is kept as its own line rather than
 * dropped. That line is what stops older records from throwing the sheet out.
 */
export interface BooksInput {
  ledgers: { id: string; name: string; perspective: string; ledger_type: string; wallet_kind: string | null; contractor_id: string | null; opening_balance: string; status: string }[];
  txns: {
    id: string;
    ledger_id: string;
    txn_date: string;
    direction: "in" | "out";
    amount: string;
    kind: string;
    is_cash: boolean;
    affects_party: boolean;
    status: string;
    reversal_of: string | null;
    wallet_ledger_id: string | null;
    nature: string | null;
    voucher_no?: string;
    description?: string | null;
  }[];
  tax: { transaction_id: string; taxable_amount: string; gst_amount: string; tds_amount: string }[];
  taxSettlements: { transaction_id: string; tax_type: string }[];
  invoices: { id: string; contractor_id: string | null; ledger_id: string | null; status: string; invoice_type: string; invoice_date: string; grand_total: string; tax_total: string; amount_received: string; transaction_id: string | null }[];
  payments: { amount: string; status: string; transaction_id: string | null }[];
  expenses: { amount: string; expense_date: string; status: string; transaction_id: string | null; split_group_id: string | null; category: string }[];
  advances: { ledger_id: string | null; amount: string; status: string; allocations: { kind: string; amount: string; status: string; alloc_date: string; transaction_id?: string | null }[] }[];
  splitGroups: { total_amount: string; paid_by_contractor_id: string | null; transaction_id: string | null; status: string }[];
  participants: { id: string; ledger_id: string; contractor_id: string | null; position: number }[];
  sharedExpenses: {
    id: string;
    ledger_id: string;
    status: "posted" | "void";
    txn_date: string;
    total_amount: string;
    description: string;
    category: string | null;
    split_group_id: string | null;
    payers: { participant_id: string; amount_paid: string }[];
    shares: { participant_id: string; share_amount: string }[];
  }[];
  settlements: { id: string; ledger_id: string; status: "posted" | "void"; from_participant_id: string; to_participant_id: string; amount: string; transaction_id: string | null }[];
}

export interface PnlLine {
  group: "income" | "cost";
  label: string;
  date: string;
  amount: Paise; // negative on a reversal
}

export interface Range {
  from?: string;
  to?: string;
}

export const OPENING = "Opening balance";

/** Lines added up per label, income first, largest first. */
export function profitAndLoss(lines: PnlLine[], range: Range = {}) {
  const within = lines.filter((l) => (!range.from || l.date >= range.from) && (!range.to || l.date <= range.to));
  const group = (g: PnlLine["group"]) => {
    const totals = new Map<string, Paise>();
    for (const l of within) if (l.group === g) totals.set(l.label, (totals.get(l.label) ?? 0n) + l.amount);
    return [...totals].filter(([, v]) => v !== 0n).sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1)).map(([label, amount]) => ({ label, amount }));
  };
  const income = group("income");
  const costs = group("cost");
  const totalIncome = sum(income.map((l) => l.amount));
  const totalCosts = sum(costs.map((l) => l.amount));
  return { income, costs, totalIncome, totalCosts, profit: totalIncome - totalCosts };
}

export function computeBooks(input: BooksInput) {
  const ledgers = new Map(input.ledgers.map((l) => [l.id, l]));
  const txns = new Map(input.txns.map((t) => [t.id, t]));
  const tax = new Map(input.tax.map((t) => [t.transaction_id, t]));
  const settled = new Map(input.taxSettlements.map((t) => [t.transaction_id, t]));
  const reversed = new Set(input.txns.filter((t) => t.reversal_of && t.status === "posted").map((t) => t.reversal_of!));
  // Cash book rows that are the money side of something else.
  const linked = new Set([...input.payments.map((p) => p.transaction_id), ...input.settlements.map((s) => s.transaction_id)].filter(Boolean) as string[]);

  const lines: PnlLine[] = [];
  const pnl = (group: PnlLine["group"], label: string, date: string, amount: Paise) => {
    if (amount !== 0n) lines.push({ group, label, date, amount });
  };

  const walletBalance = new Map<string, Paise>();
  const partyBalance = new Map<string, Paise>();
  let capital = 0n;
  let introduced = 0n; // capital added less drawings
  let unassigned = 0n; // cash that moved with no wallet named
  let uncategorised = 0n;
  let gstOutput = 0n;
  let gstInput = 0n;
  let gstPaid = 0n;
  let tdsPayable = 0n;
  let tdsPaid = 0n;
  let tdsReceivable = 0n;
  const uncategorisedEntries: BooksInput["txns"] = [];
  const notes = { billsInCashBooks: 0, expensesOnPartyLedgers: 0, taxOnPayments: 0, clientCashBooks: 0 };

  for (const l of input.ledgers) {
    if (l.perspective === "cashbook") {
      walletBalance.set(l.id, toPaise(l.opening_balance));
      capital += toPaise(l.opening_balance);
      if (l.contractor_id) notes.clientCashBooks += 1;
    } else if (l.perspective === "party") {
      partyBalance.set(l.id, toPaise(l.opening_balance));
      capital += toPaise(l.opening_balance);
    }
  }

  for (const t of input.txns) {
    if (t.status !== "posted") continue;
    const ledger = ledgers.get(t.ledger_id);
    if (!ledger) continue;
    const amount = toPaise(t.amount);
    const signed = t.direction === "in" ? amount : -amount;
    const original = t.reversal_of ? txns.get(t.reversal_of) : undefined;
    const kind = t.kind === "reversal" ? (original?.kind ?? "regular") : t.kind;

    if (ledger.perspective === "party" && t.affects_party) partyBalance.set(ledger.id, (partyBalance.get(ledger.id) ?? 0n) - signed);

    if (t.is_cash) {
      if (ledger.perspective === "cashbook") walletBalance.set(ledger.id, (walletBalance.get(ledger.id) ?? 0n) + signed);
      else if (t.wallet_ledger_id) walletBalance.set(t.wallet_ledger_id, (walletBalance.get(t.wallet_ledger_id) ?? 0n) + signed);
      else unassigned += signed;
    }

    if (kind === "tax_settlement") {
      const s = settled.get(t.reversal_of ?? t.id);
      if (s?.tax_type === "gst") gstPaid -= signed;
      else if (s?.tax_type === "tds") tdsPaid -= signed;
      else pnl("cost", "Other taxes and fees", t.txn_date, -signed);
      continue;
    }

    if (t.kind === "invoice" && tax.has(t.id) && !reversed.has(t.id)) {
      if (ledger.perspective !== "party") {
        notes.billsInCashBooks += 1;
        continue;
      }
      const d = tax.get(t.id)!;
      if (t.direction === "in") {
        pnl("cost", "Bills received", t.txn_date, toPaise(d.taxable_amount));
        gstInput += toPaise(d.gst_amount);
        tdsPayable += toPaise(d.tds_amount);
      } else {
        pnl("income", "Bills raised", t.txn_date, toPaise(d.taxable_amount));
        gstOutput += toPaise(d.gst_amount);
        tdsReceivable += toPaise(d.tds_amount);
      }
      continue;
    }

    if (kind === "regular" && t.kind === "regular" && tax.has(t.id)) notes.taxOnPayments += 1;

    // A wallet entry that is not the money side of an invoice, expense, advance or settlement.
    if (kind === "regular" && ledger.perspective === "cashbook" && !linked.has(t.id) && !(t.reversal_of && linked.has(t.reversal_of))) {
      if (t.nature === "income") pnl("income", "Other income", t.txn_date, signed);
      else if (t.nature === "expense") pnl("cost", "Other expenses", t.txn_date, -signed);
      else if (t.nature === "capital" || t.nature === "drawings") introduced += signed;
      else {
        uncategorised += signed;
        if (t.nature !== "transfer" && !t.reversal_of && !reversed.has(t.id)) uncategorisedEntries.push(t);
      }
    }
  }

  // Who owes whom, per person, across every kind of account.
  const people = new Map<string, Paise>();
  const owe = (key: string, amount: Paise) => people.set(key, (people.get(key) ?? 0n) + amount);
  for (const l of input.ledgers) {
    if (l.perspective === "party") owe(l.contractor_id ?? `ledger:${l.id}`, partyBalance.get(l.id) ?? 0n);
  }

  for (const i of input.invoices) {
    if (i.status !== "issued" || i.invoice_type === "proforma") continue;
    const total = toPaise(i.grand_total);
    const taxTotal = toPaise(i.tax_total);
    pnl("income", "Invoices", i.invoice_date, total - taxTotal);
    gstOutput += taxTotal;
    const inParty = i.transaction_id && i.ledger_id && ledgers.get(i.ledger_id)?.perspective === "party";
    if (!inParty) owe(i.contractor_id ?? `invoice:${i.id}`, total - toPaise(i.amount_received));
  }
  for (const p of input.payments) {
    if (p.status === "confirmed" && !p.transaction_id) unassigned += toPaise(p.amount);
  }

  for (const e of input.expenses) {
    if (e.status !== "active") continue;
    const row = e.transaction_id ? txns.get(e.transaction_id) : undefined;
    if (row && ledgers.get(row.ledger_id)?.perspective === "party") {
      // Older records only: it reads as money that party owes you, so it stays there, once.
      notes.expensesOnPartyLedgers += 1;
      continue;
    }
    pnl("cost", e.category, e.expense_date, toPaise(e.amount));
    if (!e.transaction_id && !e.split_group_id) unassigned -= toPaise(e.amount);
  }

  for (const g of input.splitGroups) {
    if (g.status === "active" && !g.paid_by_contractor_id && !g.transaction_id) unassigned -= toPaise(g.total_amount);
  }

  let advances = 0n;
  for (const a of input.advances) {
    if (a.status !== "active") continue;
    const onParty = a.ledger_id ? ledgers.get(a.ledger_id)?.perspective === "party" : false;
    if (onParty) continue; // already inside that party's balance
    const live = a.allocations.filter((x) => x.status === "active");
    advances += toPaise(a.amount) - sum(live.map((x) => toPaise(x.amount)));
    if (!a.ledger_id) unassigned -= toPaise(a.amount);
    for (const x of live) {
      if (x.kind === "recovery" && !a.ledger_id) unassigned += toPaise(x.amount);
      if (x.kind === "adjustment" && !x.transaction_id) pnl("cost", "Advances adjusted against work", x.alloc_date, toPaise(x.amount));
    }
  }

  // Shared accounts, from the business's side: the first person in each is the owner.
  const byLedger = <T extends { ledger_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.ledger_id, [...(m.get(r.ledger_id) ?? []), r]);
    return m;
  };
  const sharedPeople = byLedger(input.participants);
  const sharedExpenses = byLedger(input.sharedExpenses);
  const sharedSettlements = byLedger(input.settlements);
  for (const l of input.ledgers) {
    if (l.perspective !== "personal") continue;
    const ps = [...(sharedPeople.get(l.id) ?? [])].sort((a, b) => a.position - b.position);
    const owner = ps[0];
    if (!owner) continue;
    const ids = ps.map((p) => p.id);
    const expenses = (sharedExpenses.get(l.id) ?? []).filter((e) => e.status === "posted");
    const settlements = (sharedSettlements.get(l.id) ?? []).filter((s) => s.status === "posted");
    for (const e of expenses) {
      const fx = expenseEffect(e, owner.id);
      if (e.description === OPENING && e.category === OPENING) capital += fx.effect;
      else if (!e.split_group_id) {
        unassigned -= fx.paid;
        pnl("cost", "Your share of shared expenses", e.txn_date, fx.share);
      }
    }
    for (const s of settlements) {
      if (s.transaction_id) continue; // the wallet entry carries the cash
      if (s.from_participant_id === owner.id) unassigned -= toPaise(s.amount);
      if (s.to_participant_id === owner.id) unassigned += toPaise(s.amount);
    }
    for (const d of simplifyDebts(participantBalances(ids, expenses, settlements), ids)) {
      if (d.to === owner.id) {
        const other = ps.find((p) => p.id === d.from)!;
        owe(other.contractor_id ?? `participant:${other.id}`, d.amount);
      } else if (d.from === owner.id) {
        const other = ps.find((p) => p.id === d.to)!;
        owe(other.contractor_id ?? `participant:${other.id}`, -d.amount);
      }
    }
  }

  const wallets = input.ledgers
    .filter((l) => l.perspective === "cashbook")
    .map((l) => ({ id: l.id, name: l.name, kind: l.wallet_kind === "cash" ? ("cash" as const) : ("bank" as const), balance: walletBalance.get(l.id) ?? 0n, status: l.status }));
  const cash = sum(wallets.filter((w) => w.kind === "cash").map((w) => w.balance));
  const bank = sum(wallets.filter((w) => w.kind === "bank").map((w) => w.balance));

  const positive = [...people.values()].filter((v) => v > 0n);
  const negative = [...people.values()].filter((v) => v < 0n);
  const debtors = sum(positive);
  const creditors = -sum(negative);

  const gstNet = gstOutput - gstInput - gstPaid;
  const gstPayable = gstNet > 0n ? gstNet : 0n;
  const gstCredit = gstNet < 0n ? -gstNet : 0n;
  const tdsDue = tdsPayable - tdsPaid;

  const allTime = profitAndLoss(lines);
  const assets = cash + bank + debtors + advances + gstCredit + tdsReceivable + (unassigned > 0n ? unassigned : 0n);
  const liabilities = creditors + gstPayable + tdsDue + (unassigned < 0n ? -unassigned : 0n);
  const equity = capital + introduced + allTime.profit + uncategorised;

  return {
    wallets,
    cash,
    bank,
    unassigned,
    debtors,
    creditors,
    debtorCount: positive.length,
    creditorCount: negative.length,
    positions: people,
    advances,
    gstPayable,
    gstCredit,
    tdsDue,
    tdsReceivable,
    assets,
    liabilities,
    capital,
    introduced,
    profit: allTime.profit,
    uncategorised,
    uncategorisedEntries,
    equity,
    difference: assets - liabilities - equity,
    lines,
    notes,
  };
}

export type Books = ReturnType<typeof computeBooks>;

/** Which wallet a payment mode points to by default. Cash to cash, everything else to the bank. */
export function walletForMode<T extends { id: string; kind: "cash" | "bank" | null }>(wallets: T[], mode: string): string {
  if (mode === "cash") return wallets.find((w) => w.kind === "cash")?.id ?? "";
  if (["upi", "bank_transfer", "cheque", "card"].includes(mode)) return wallets.find((w) => w.kind === "bank")?.id ?? "";
  return "";
}
