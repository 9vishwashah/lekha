import Link from "next/link";
import { getWorkspace } from "@/lib/server/context";
import { loadBooks } from "@/lib/server/books";
import { loadSharedAccountRows } from "@/lib/server/people";
import { profitAndLoss } from "@/lib/domain/books";
import { formatDateShort } from "@/lib/domain/dates";
import { formatINR, toPaise } from "@/lib/domain/money";
import { listContractors, listLedgers } from "@/lib/server/queries";
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
  const [books, ledgers, clients] = await Promise.all([loadBooks(ctx.db, ctx.workspace.id, shared), listLedgers(ctx.db, ctx.workspace.id), listContractors(ctx.db, ctx.workspace.id)]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const people = [...books.positions]
    .filter(([, v]) => v !== 0n)
    .map(([key, amount]) => {
      const sources = books.breakdown.get(key) ?? [];
      return { key, amount, name: clientName.get(key) ?? sources[0]?.label ?? "Someone", href: clientName.has(key) ? `/contractors/${key}` : (sources[0]?.href ?? "/books"), sources };
    })
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
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

      <section aria-label="Who owes what" className="flex flex-col gap-4">
        <SectionTitle>Who owes what</SectionTitle>
        <p className="text-[15px] text-ink-2">One line per person, netted across every ledger, invoice, advance and shared account with them. Archived ledgers count until they are settled.</p>
        {people.length === 0 ? (
          <p className="text-ink-2">Everyone is settled.</p>
        ) : (
          <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
            {people.map((p) => (
              <li key={p.key}>
                <Link href={p.href} className="flex items-center gap-3 px-5 py-3 hover:bg-white">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block truncate text-[13px] text-ink-3">
                      {p.sources.map((s) => `${s.note} ${formatINR(s.amount > 0n ? s.amount : -s.amount)}${s.amount < 0n ? " you owe" : ""}`).join(" · ")}
                    </span>
                  </span>
                  <span className="text-right">
                    <Money value={p.amount > 0n ? p.amount : -p.amount} tone={p.amount > 0n ? "in" : "out"} className="block font-semibold" />
                    <span className="text-[12px] text-ink-3">{p.amount > 0n ? "owes you" : "you owe"}</span>
                  </span>
                </Link>
              </li>
            ))}
            <li className="flex justify-between gap-3 px-5 py-3 text-[15px] font-semibold">
              <span>Owe you · You owe</span>
              <span className="num">
                {formatINR(books.debtors)} · {formatINR(books.creditors)}
              </span>
            </li>
          </ul>
        )}
      </section>

      {(notes.length > 0 || entries.length > 0 || books.unassigned !== 0n || books.duplicates.length > 0) && (
        <section aria-label="Needs a look" className="flex flex-col gap-4">
          <SectionTitle>Needs a look</SectionTitle>
          {books.duplicates.map((d) => (
            <p key={`${d.ledgerId}${d.voucher}`} className="rounded-2xl bg-mustard/40 p-4 text-[15px]">
              Possibly billed twice: bill {d.voucher} for {formatINR(d.amount)} on{" "}
              <Link href={`/ledgers/${d.ledgerId}`} className="font-semibold underline underline-offset-4">{d.ledgerName}</Link> and invoice{" "}
              <Link href={`/invoices/${d.invoiceId}`} className="font-semibold underline underline-offset-4">{d.invoiceNo}</Link> look like the same job. Both are counted. If they are one job, void the bill on the ledger, or reverse it.
            </p>
          ))}
          {books.unassigned !== 0n && (
            <p id="wallets" className="rounded-2xl bg-sunken p-4 text-[15px] text-ink-2">
              {formatINR(books.pocket > 0n ? books.pocket : -books.pocket)} {books.pocket > 0n ? "was paid" : "was received"} without naming a wallet: older shared expenses, advances and payments. It is shown with what you put in, as {books.pocket > 0n ? "paid from your own pocket" : "received outside your wallets"}. To move it into Cash or Bank, open each entry on a client ledger and say which wallet it went through, and pick a wallet on new entries.
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

