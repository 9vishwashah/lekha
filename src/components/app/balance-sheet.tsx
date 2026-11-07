import { IntentLink } from "@/components/app/intent-link";
import { Amount, Money } from "@/components/ui/amount";
import type { Books } from "@/lib/domain/books";
import { formatINR } from "@/lib/domain/money";
import { cn } from "@/lib/cn";

interface Row {
  label: string;
  term?: string;
  value: bigint;
  href?: string;
  always?: boolean;
}

function Side({ title, note, total, rows, tone }: { title: string; note: string; total: bigint; rows: Row[]; tone: string }) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-5 rounded-[var(--radius-card)] p-5 sm:p-7", tone)}>
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <Amount value={total} size="lg" className="mt-3 block truncate text-[2.2rem] sm:text-[3.2rem]" />
        <p className="mt-1 text-[13px] opacity-75">{note}</p>
      </div>
      <dl className="flex flex-col divide-y divide-current/15 text-[15px]">
        {rows
          .filter((r) => r.always || r.value !== 0n)
          .map((r) => {
            const inner = (
              <>
                <dt className="min-w-0">
                  <span className="block truncate font-medium">{r.label}</span>
                  {r.term && <span className="block truncate text-[12px] opacity-70">{r.term}</span>}
                </dt>
                <dd>
                  <Money value={r.value} className="font-semibold" />
                </dd>
              </>
            );
            return r.href ? (
              <IntentLink key={r.label} href={r.href} className="flex min-h-12 items-center justify-between gap-3 py-2 hover:opacity-80">
                {inner}
              </IntentLink>
            ) : (
              <div key={r.label} className="flex min-h-12 items-center justify-between gap-3 py-2">
                {inner}
              </div>
            );
          })}
      </dl>
    </section>
  );
}

/** Both sides of the books. The total on the right is added up from its own lines, never copied. */
export function BalanceSheet({ books, plural }: { books: Books; plural: (n: number) => string }) {
  const b = books;
  const left: Row[] = [
    { label: "Cash in hand", value: b.cash, href: "/ledgers", always: true },
    { label: "Bank & UPI", value: b.bank, href: "/ledgers", always: true },
    { label: "People owe you", term: `Sundry debtors · ${plural(b.debtorCount)}`, value: b.debtors, href: "/contractors?sort=owes", always: true },
    { label: "Advances given", value: b.advances, href: "/advances" },
    { label: "GST credit", term: "More paid than collected", value: b.gstCredit, href: "/reports/tax" },
    { label: "TDS deducted by clients", value: b.tdsReceivable, href: "/reports/tax" },
    { label: "Received, not in a wallet", term: "Say which wallet in Books", value: b.unassigned > 0n ? b.unassigned : 0n, href: "/books" },
  ];
  const right: Row[] = [
    { label: "You owe people", term: `Sundry creditors · ${plural(b.creditorCount)}`, value: b.creditors, href: "/contractors?sort=owe", always: true },
    { label: "GST to pay", value: b.gstPayable, href: "/reports/tax" },
    { label: "TDS to pay", value: b.tdsDue, href: "/reports/tax" },
    { label: "Spent, not from a wallet", term: "Say which wallet in Books", value: b.unassigned < 0n ? -b.unassigned : 0n, href: "/books" },
    { label: "Opening capital", term: "Balances you started with", value: b.capital },
    { label: "Capital added, less drawings", value: b.introduced },
    { label: b.profit < 0n ? "Loss to date" : "Profit to date", term: "Income less costs", value: b.profit, href: "/books", always: true },
    { label: "Uncategorised entries", term: "Not yet income, cost or capital", value: b.uncategorised, href: "/books" },
  ];
  const balanced = b.difference === 0n;
  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        <Side title="What you have" note="Assets" total={b.assets} rows={left} tone="bg-tea text-seashell" />
        <Side title="What you owe, and what is yours" note="Liabilities and net worth" total={b.liabilities + b.equity} rows={right} tone="bg-ink text-seashell" />
      </div>
      <p className={cn("rounded-2xl px-4 py-3 text-[13px] font-medium", balanced ? "bg-sunken text-ink-2" : "bg-red text-white")}>
        {balanced
          ? `Balanced: ${formatINR(b.assets)} = ${formatINR(b.liabilities)} owed + ${formatINR(b.equity)} net worth.`
          : `Out by ${formatINR(b.difference)}. This should never happen, so these figures should not be relied on yet.`}
      </p>
    </>
  );
}
