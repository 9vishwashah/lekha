import { notFound, redirect } from "next/navigation";
import { requireUser, getMemberships, getWorkspace } from "@/lib/server/context";
import { userDb } from "@/lib/supabase/server";
import { getLedger, getLedgerTax, getLedgerTxns, getPersonalLedger, getShareAcknowledgement, listLedgers, peopleNames, reversedIds, walletsOf } from "@/lib/server/queries";
import { ledgerAccess } from "@/lib/server/access";
import { buildStatement, describeBalance, type Perspective } from "@/lib/domain/ledger";
import { toDecimal, toPaise } from "@/lib/domain/money";
import { isISODate, todayISO } from "@/lib/domain/dates";
import { LedgerScreen } from "@/components/app/ledger-screen";
import { matchesSearch } from "@/lib/domain/search";
import { PersonalLedger } from "@/components/app/personal/personal-ledger";
import { advancesWithPositions } from "@/lib/server/workspace-data";

async function optional<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    console.error("ledger page: optional data failed", e);
    return fallback;
  }
}

export default async function LedgerPage(props: PageProps<"/ledgers/[id]">) {
  const userId = await requireUser();
  const { id } = await props.params;
  const params = (await props.searchParams) as Record<string, string>;
  const db = await userDb();
  const today = todayISO();
  // One parallel round: everything this screen might need is requested at once, and RLS decides
  // what comes back (tax rows, advances and member names are simply empty when not permitted).
  // Only the ledger and its entries are essential; the extras fall back to empty so a slow side
  // query never replaces the whole ledger with an error page.
  const [ledger, txns, tax, names, advances, personal, memberships] = await Promise.all([
    getLedger(db, id),
    getLedgerTxns(db, id),
    optional(getLedgerTax(db, id), new Map()),
    optional(peopleNames(db, null, id), new Map<string, string>()),
    optional(advancesWithPositions(db, null, today), []),
    getPersonalLedger(db, id).catch((e: unknown) => e as Error),
    optional(getMemberships(), []),
  ]);
  const access = await ledgerAccess(ledger);
  if (!access) notFound();

  // A one-to-one account made by adding an expense or payment with someone is not a ledger of its
  // own: the person's client page is their account. Send people there.
  if (ledger.is_direct) {
    if (access.kind === "member" && ledger.contractor_id) redirect(`/contractors/${ledger.contractor_id}`);
    if (memberships.length > 0) {
      const ctx = await getWorkspace();
      const { data: card } = await db
        .from("contractors")
        .select("id")
        .eq("workspace_id", ctx.workspace.id)
        .eq("linked_user_id", ledger.owner_user_id)
        .limit(1)
        .maybeSingle();
      if (card) redirect(`/contractors/${card.id}`);
    }
  }

  if (ledger.ledger_type === "personal") {
    if (personal instanceof Error) throw personal;
    return (
      <PersonalLedger ledger={ledger} access={access} userId={userId} today={today} openAdd={params.add === "1"} data={personal} names={names} />
    );
  }

  const membership = memberships.find((m) => m.workspace.id === ledger.workspace_id);
  const [ledgerList, acknowledgement] = await Promise.all([
    membership ? optional(listLedgers(db, ledger.workspace_id), []) : Promise.resolve([]),
    access.canManage ? optional(getShareAcknowledgement(db, ledger.id, ledger.last_activity_at), null) : Promise.resolve(null),
  ]);
  const wallets = membership ? walletsOf(ledgerList) : [];

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
        matchesSearch(row, q),
    )
    .map(({ row, counted, running }) => ({ txn: row, counted, running: toDecimal(running), reversed: reversed.has(row.id) }));

  const contractorAdvances = ledger.contractor_id ? advances.filter((a) => a.contractor_id === ledger.contractor_id && a.status === "active") : [];
  const outstandingAdvance = contractorAdvances.reduce((acc, a) => acc + a.position.outstanding, 0n);

  return (
    <LedgerScreen
      wallets={wallets}
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
      acknowledgement={acknowledgement}
      visibleIn={toDecimal(lines.filter((l) => l.txn.status === "posted" && l.txn.direction === "in" && l.txn.is_cash).reduce((a, l) => a + toPaise(l.txn.amount), 0n))}
      visibleOut={toDecimal(lines.filter((l) => l.txn.status === "posted" && l.txn.direction === "out" && l.txn.is_cash).reduce((a, l) => a + toPaise(l.txn.amount), 0n))}
    />
  );
}
