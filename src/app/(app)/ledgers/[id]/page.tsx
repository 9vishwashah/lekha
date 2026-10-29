import { notFound } from "next/navigation";
import { requireUser, getMemberships } from "@/lib/server/context";
import { userDb } from "@/lib/supabase/server";
import { getLedger, getLedgerTax, getLedgerTxns, getPersonalLedger, peopleNames, reversedIds } from "@/lib/server/queries";
import { ledgerAccess } from "@/lib/server/access";
import { buildStatement, describeBalance, type Perspective } from "@/lib/domain/ledger";
import { toDecimal, toPaise } from "@/lib/domain/money";
import { isISODate, todayISO } from "@/lib/domain/dates";
import { LedgerScreen } from "@/components/app/ledger-screen";
import { PersonalLedger } from "@/components/app/personal/personal-ledger";
import { advancesWithPositions } from "@/lib/server/workspace-data";

export default async function LedgerPage(props: PageProps<"/ledgers/[id]">) {
  const userId = await requireUser();
  const { id } = await props.params;
  const params = (await props.searchParams) as Record<string, string>;
  const db = await userDb();
  const today = todayISO();
  // One parallel round: everything this screen might need is requested at once, and RLS decides
  // what comes back (tax rows, advances and member names are simply empty when not permitted).
  const [ledger, txns, tax, names, advances, personal, memberships] = await Promise.all([
    getLedger(db, id),
    getLedgerTxns(db, id),
    getLedgerTax(db, id),
    peopleNames(db, null, id),
    advancesWithPositions(db, null, today),
    getPersonalLedger(db, id),
    getMemberships(),
  ]);
  const access = await ledgerAccess(ledger);
  if (!access) notFound();

  if (ledger.ledger_type === "personal") {
    return (
      <PersonalLedger ledger={ledger} access={access} userId={userId} today={today} openAdd={params.add === "1"} data={personal} names={names} />
    );
  }

  const membership = memberships.find((m) => m.workspace.id === ledger.workspace_id);

  const range = {
    from: params.from && isISODate(params.from) ? params.from : undefined,
    to: params.to && isISODate(params.to) ? params.to : undefined,
  };
  const perspective = ledger.perspective as Perspective;
  const statement = buildStatement({ perspective, opening_balance: ledger.opening_balance }, txns, range);
  const meaning = describeBalance(perspective, statement.closing, ledger.contractor?.name);
  const reversed = reversedIds(txns);

  // Filters only hide rows; balances still come from every entry.
  const q = (params.q ?? "").trim().toLowerCase();
  const dir = params.dir === "in" || params.dir === "out" ? params.dir : null;
  const status = ["posted", "draft", "void"].includes(params.status) ? params.status : null;
  const lines = statement.lines
    .filter(({ row }) => !dir || row.direction === dir)
    .filter(({ row }) => !status || row.status === status)
    .filter(
      ({ row }) =>
        !q ||
        [row.description, row.counterparty, row.reference_no, row.voucher_no, row.amount].some((v) => v?.toLowerCase().includes(q)),
    )
    .map(({ row, counted, running }) => ({ txn: row, counted, running: toDecimal(running), reversed: reversed.has(row.id) }));

  const contractorAdvances = ledger.contractor_id ? advances.filter((a) => a.contractor_id === ledger.contractor_id && a.status === "active") : [];
  const outstandingAdvance = contractorAdvances.reduce((acc, a) => acc + a.position.outstanding, 0n);

  return (
    <LedgerScreen
      ledger={{
        id: ledger.id,
        name: ledger.name,
        color: ledger.color,
        ledger_type: ledger.ledger_type as "basic" | "taxation",
        perspective,
        gst_mode: ledger.gst_mode,
        status: ledger.status,
        partyName: ledger.contractor?.name ?? null,
        contractorId: ledger.contractor_id,
        reference: ledger.reference_no,
        openingDate: ledger.opening_balance_date,
      }}
      summary={{
        opening: toDecimal(statement.opening),
        closing: toDecimal(statement.closing),
        moneyIn: toDecimal(statement.totals.moneyIn),
        moneyOut: toDecimal(statement.totals.moneyOut),
        billsIn: toDecimal(statement.totals.billsIn),
        billsOut: toDecimal(statement.totals.billsOut),
        meaning: meaning.label,
        hint: meaning.hint,
        drafts: statement.totals.draftCount,
        advanceOutstanding: contractorAdvances.length ? toDecimal(outstandingAdvance) : null,
        lastActivity: ledger.last_activity_at,
        totalEntries: txns.length,
      }}
      lines={lines}
      tax={Object.fromEntries(tax)}
      names={Object.fromEntries(names)}
      access={access}
      userId={userId}
      today={today}
      taxDefaults={{
        gstRate: membership ? String(Number(membership.workspace.default_gst_rate)) : "18",
        tdsRate: membership ? String(Number(membership.workspace.default_tds_rate)) : "1",
        tdsBase: membership?.workspace.default_tds_base ?? "taxable",
      }}
      filters={{ q: params.q ?? "", dir: dir ?? "", status: status ?? "", from: range.from ?? "", to: range.to ?? "" }}
      openAdd={params.add === "1"}
      hasFilters={Boolean(q || dir || status || range.from || range.to)}
      visibleIn={toDecimal(lines.filter((l) => l.txn.status === "posted" && l.txn.direction === "in" && l.txn.is_cash).reduce((a, l) => a + toPaise(l.txn.amount), 0n))}
      visibleOut={toDecimal(lines.filter((l) => l.txn.status === "posted" && l.txn.direction === "out" && l.txn.is_cash).reduce((a, l) => a + toPaise(l.txn.amount), 0n))}
    />
  );
}
