import Link from "next/link";
import { getWorkspace } from "@/lib/server/context";
import { loadBooks } from "@/lib/server/books";
import { loadSharedAccountRows } from "@/lib/server/people";
import { profitAndLoss } from "@/lib/domain/books";
import { formatDateShort } from "@/lib/domain/dates";
import { toPaise } from "@/lib/domain/money";
import { listLedgers } from "@/lib/server/queries";
import { BalanceSheet } from "@/components/app/balance-sheet";
import { PeriodTabs, resolvePeriod } from "@/components/app/period-tabs";
import { Amount, Money } from "@/components/ui/amount";
import { PageHeader, SectionTitle } from "@/components/ui/bits";
import { ClassifyEntry } from "./classify";

export const metadata = { title: "Books" };

function Lines({ title, lines, total }: { title: string; lines: { label: string; amount: bigint }[]; total: bigint }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink-2">{title}</h3>
      <dl className="mt-2 divide-y divide-line text-[15px]">
        {lines.length === 0 && <div className="py-2.5 text-ink-3">Nothing in this period</div>}
        {lines.map((l) => (
          <div key={l.label} className="flex items-center justify-between gap-3 py-2.5">
            <dt className="min-w-0 truncate">{l.label}</dt>
            <dd>
              <Money value={l.amount} />
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 py-2.5 font-semibold">
          <dt>Total</dt>
          <dd>
            <Money value={total} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default async function BooksPage(props: PageProps<"/books">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const period = resolvePeriod(params, ctx.workspace.fy_start_month, "fy");
  const shared = await loadSharedAccountRows(ctx.db);
  const [books, ledgers] = await Promise.all([loadBooks(ctx.db, ctx.workspace.id, shared), listLedgers(ctx.db, ctx.workspace.id)]);
  const pnl = profitAndLoss(books.lines, period.range);
  const plural = (n: number) => (n === 1 ? "1 person" : `${n} people`);
  const ledgerName = new Map(ledgers.map((l) => [l.id, l.name]));
  const entries = [...books.uncategorisedEntries].sort((a, b) => (a.txn_date < b.txn_date ? 1 : -1));
  const notes = [
    books.notes.billsInCashBooks > 0 && `${books.notes.billsInCashBooks} bill${books.notes.billsInCashBooks === 1 ? " sits" : "s sit"} in a cash book, so ${books.notes.billsInCashBooks === 1 ? "it isn't" : "they aren't"} counted here. Bills belong in a ledger with a client.`,
    books.notes.expensesOnPartyLedgers > 0 && `${books.notes.expensesOnPartyLedgers} older expense${books.notes.expensesOnPartyLedgers === 1 ? " was" : "s were"} paid through a party ledger. That reads as money that party owes you, so ${books.notes.expensesOnPartyLedgers === 1 ? "it stays" : "they stay"} there and out of costs.`,
    books.notes.taxOnPayments > 0 && `${books.notes.taxOnPayments} payment${books.notes.taxOnPayments === 1 ? " has" : "s have"} GST or TDS attached without a bill. The Tax page counts ${books.notes.taxOnPayments === 1 ? "it" : "them"}; the books don't. Record a bill instead.`,
    books.notes.clientCashBooks > 0 && `${books.notes.clientCashBooks} cash book${books.notes.clientCashBooks === 1 ? " is" : "s are"} set up for a client and ${books.notes.clientCashBooks === 1 ? "holds" : "hold"} money, so ${books.notes.clientCashBooks === 1 ? "it counts" : "they count"} as your own money. Use a client ledger for new entries.`,
  ].filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Books" kicker={ctx.workspace.name}>
        <p className="mt-3 max-w-2xl text-ink-2">Worked out from everything you record. Income counts when you invoice, costs when they are incurred, and GST and TDS are never profit.</p>
      </PageHeader>

      <section aria-label="Balance sheet" className="flex flex-col gap-3">
        <SectionTitle>Where you stand today</SectionTitle>
        <BalanceSheet books={books} plural={plural} />
      </section>

      <section aria-label="Profit and loss" className="flex flex-col gap-4">
        <SectionTitle>Profit and loss</SectionTitle>
        <PeriodTabs basePath="/books" active={period.key} from={params.from} to={params.to} />
        <div className="grid gap-6 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 sm:p-7 lg:grid-cols-2">
          <Lines title="Income" lines={pnl.income} total={pnl.totalIncome} />
          <Lines title="Costs" lines={pnl.costs} total={pnl.totalCosts} />
        </div>
        <div className="rounded-[var(--radius-card)] bg-mustard p-5 text-ink sm:p-7">
          <div className="text-sm font-semibold">{pnl.profit < 0n ? "Loss" : "Profit"} · {period.label}</div>
          <Amount value={pnl.profit < 0n ? -pnl.profit : pnl.profit} size="lg" className="mt-3 block truncate text-[2.2rem] sm:text-[3.2rem]" />
        </div>
      </section>

      {(notes.length > 0 || entries.length > 0 || books.unassigned !== 0n) && (
        <section aria-label="Needs a look" className="flex flex-col gap-4">
          <SectionTitle>Needs a look</SectionTitle>
          {books.unassigned !== 0n && (
            <p className="rounded-2xl bg-sunken p-4 text-[15px] text-ink-2">
              Some money moved without naming a wallet, so Cash and Bank can&apos;t see it. It still counts, as its own line. Open an entry on a client ledger to say which wallet it went through, and choose a wallet on new entries.
            </p>
          )}
          {notes.map((n) => (
            <p key={n} className="rounded-2xl bg-sunken p-4 text-[15px] text-ink-2">{n}</p>
          ))}
          {entries.length > 0 && (
            <>
              <h3 className="text-[15px] font-semibold">Wallet entries with no meaning yet ({entries.length})</h3>
              <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
                {entries.slice(0, 30).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <Link href={`/ledgers/${t.ledger_id}`} className="min-w-0 flex-1 basis-48">
                      <span className="block truncate font-medium">{t.description || t.voucher_no}</span>
                      <span className="block text-[13px] text-ink-3">{ledgerName.get(t.ledger_id)} · {formatDateShort(t.txn_date, period.today)}</span>
                    </Link>
                    <Money value={toPaise(t.amount)} tone={t.direction === "in" ? "in" : "out"} className="font-semibold" />
                    {ctx.canWrite && <ClassifyEntry id={t.id} direction={t.direction} />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

