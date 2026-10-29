import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { ledgerBalances } from "@/lib/server/workspace-data";
import { PeriodTabs, resolvePeriod } from "@/components/app/period-tabs";
import { Money } from "@/components/ui/amount";
import { PageHeader, SectionTitle } from "@/components/ui/bits";
import { describeBalance, type Perspective } from "@/lib/domain/ledger";
import { cn } from "@/lib/cn";

export const metadata = { title: "Reports" };

export default async function ReportsPage(props: PageProps<"/reports">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const period = resolvePeriod(params, ctx.workspace.fy_start_month, "fy");
  const { entries, moneyIn, moneyOut } = await ledgerBalances(ctx.db, ctx.workspace.id, period.range);
  const qs = new URLSearchParams({ ...(period.range.from && { from: period.range.from }), ...(period.range.to && { to: period.range.to }) }).toString();
  const ledgers = entries.filter((e) => e.ledger.ledger_type !== "personal");

  // Contractor-wise activity from the same statements as the ledger screens.
  const byContractor = new Map<string, { name: string; in: bigint; out: bigint; ledgers: number }>();
  for (const e of ledgers) {
    const key = e.ledger.contractor?.id ?? "none";
    const row = byContractor.get(key) ?? { name: e.ledger.contractor?.name ?? "No client", in: 0n, out: 0n, ledgers: 0 };
    row.in += e.periodStatement?.totals.moneyIn ?? 0n;
    row.out += e.periodStatement?.totals.moneyOut ?? 0n;
    row.ledgers += 1;
    byContractor.set(key, row);
  }

  const reports = [
    { href: "/reports/tax", title: "Monthly tax summary", body: "GST by type, TDS withheld, gross and net bills, and GST paid.", color: "bg-lavender" },
    { href: `/api/export/report?type=balances&format=pdf&${qs}`, title: "Ledger balances", body: "Every ledger with money in, money out and what its balance means.", color: "bg-mustard", download: true },
    { href: `/expenses?${qs || "period=fy"}`, title: "Expense summary", body: "Totals by category and month, with Excel and PDF export.", color: "bg-sky" },
    { href: "/advances?show=open", title: "Outstanding advances", body: "Who still owes money advanced, and what is overdue.", color: "bg-pink" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Reports" />
      <PeriodTabs basePath="/reports" active={period.key} from={params.from} to={params.to} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {reports.map((r) =>
          r.download ? (
            <a key={r.title} href={r.href} className={cn("group flex min-h-48 flex-col justify-between rounded-[var(--radius-card)] p-5", r.color)}>
              <ReportCard title={r.title} body={r.body} />
            </a>
          ) : (
            <Link key={r.title} href={r.href} className={cn("group flex min-h-48 flex-col justify-between rounded-[var(--radius-card)] p-5", r.color)}>
              <ReportCard title={r.title} body={r.body} />
            </Link>
          ),
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle
          action={
            <span className="flex gap-1">
              <a href={`/api/export/report?type=balances&format=xlsx&${qs}`} className="inline-flex h-10 items-center rounded-full px-3 text-sm font-medium hover:bg-sunken">
                Excel
              </a>
              <a href={`/api/export/report?type=balances&format=csv&${qs}`} className="inline-flex h-10 items-center rounded-full px-3 text-sm font-medium hover:bg-sunken">
                CSV
              </a>
            </span>
          }
        >
          Money in and out · {period.label.toLowerCase()}
        </SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[var(--radius-card)] bg-tea p-5 text-seashell">
            <div className="text-sm opacity-75">Money in</div>
            <Money value={moneyIn} className="display mt-3 block text-3xl font-bold sm:text-4xl" />
          </div>
          <div className="rounded-[var(--radius-card)] bg-ink p-5 text-seashell">
            <div className="text-sm opacity-75">Money out</div>
            <Money value={moneyOut} className="display mt-3 block text-3xl font-bold sm:text-4xl" />
          </div>
        </div>
        <div className="overflow-x-auto rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
          <table className="w-full min-w-[640px] text-left text-[14px]">
            <caption className="sr-only">Ledger statements for the period</caption>
            <thead className="bg-ink text-surface">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Ledger</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Money in</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Money out</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Balance now</th>
                <th scope="col" className="px-4 py-3 font-medium">Statement</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ledgers.map((e) => (
                <tr key={e.ledger.id}>
                  <td className="px-4 py-3">
                    <Link href={`/ledgers/${e.ledger.id}`} className="font-medium hover:underline">
                      {e.ledger.name}
                    </Link>
                    <div className="text-[12px] text-ink-3">{describeBalance(e.ledger.perspective as Perspective, e.statement?.closing ?? 0n, e.ledger.contractor?.name).label}</div>
                  </td>
                  <td className="px-3 py-3 text-right"><Money value={e.periodStatement?.totals.moneyIn ?? 0n} tone="in" /></td>
                  <td className="px-3 py-3 text-right"><Money value={e.periodStatement?.totals.moneyOut ?? 0n} tone="out" /></td>
                  <td className="px-3 py-3 text-right font-semibold"><Money value={e.statement?.closing ?? 0n} /></td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <a className="font-medium underline-offset-2 hover:underline" href={`/api/export/ledger/${e.ledger.id}?format=pdf&${qs}`}>PDF</a>
                    {" · "}
                    <a className="font-medium underline-offset-2 hover:underline" href={`/api/export/ledger/${e.ledger.id}?format=xlsx&${qs}`}>Excel</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>By client · {period.label.toLowerCase()}</SectionTitle>
        <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
          {[...byContractor.entries()].map(([key, r]) => (
            <li key={key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <span>
                {key === "none" ? <span className="font-medium">{r.name}</span> : <Link href={`/contractors/${key}`} className="font-medium hover:underline">{r.name}</Link>}
                <span className="block text-[13px] text-ink-3">{r.ledgers} ledgers</span>
              </span>
              <span className="flex gap-4 text-[14px]">
                <span>In <Money value={r.in} tone="in" className="font-semibold" /></span>
                <span>Out <Money value={r.out} tone="out" className="font-semibold" /></span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ReportCard({ title, body }: { title: string; body: string }) {
  return (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="display text-2xl font-bold">{title}</span>
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-white/80 transition-transform group-hover:rotate-45">
          <ArrowUpRight className="size-5" />
        </span>
      </span>
      <span className="text-sm text-ink/75">{body}</span>
    </>
  );
}
