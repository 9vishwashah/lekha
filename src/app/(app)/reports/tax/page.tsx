import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { workspaceTaxSummary } from "@/lib/server/report-data";
import { PeriodTabs, resolvePeriod } from "@/components/app/period-tabs";
import { Amount, Money } from "@/components/ui/amount";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { monthLabel, formatDate } from "@/lib/domain/dates";
import { toPaise } from "@/lib/domain/money";
import { cn } from "@/lib/cn";

export const metadata = { title: "Tax summary" };

export default async function TaxReport(props: PageProps<"/reports/tax">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const period = resolvePeriod(params, ctx.workspace.fy_start_month, "fy");
  const basis = params.basis === "payment" ? "payment" : "invoice";
  const ledgerId = params.ledger || undefined;
  const { summary, ledgers, details } = await workspaceTaxSummary(ctx.db, ctx.workspace.id, basis, period.range, ledgerId);
  const extra = { basis, ...(ledgerId && { ledger: ledgerId }) };
  const qs = new URLSearchParams({ type: "tax", ...extra, ...(period.range.from && { from: period.range.from }), ...(period.range.to && { to: period.range.to }) });
  const t = summary.total;
  const inRange = (d: string) => (!period.range.from || d >= period.range.from) && (!period.range.to || d <= period.range.to);
  const lines = details
    .filter((d) => d.status === "posted" && !d.reversed && inRange(basis === "invoice" ? (d.invoice_date ?? d.txn_date) : d.txn_date))
    .sort((a, b) => (a.txn_date < b.txn_date ? 1 : -1));

  return (
    <div className="flex flex-col gap-6">
      <Link href="/reports" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Reports
      </Link>
      <PageHeader
        title="Tax summary"
        actions={
          <>
            {["xlsx", "pdf", "csv"].map((f) => (
              <a key={f} href={`/api/export/report?${qs}&format=${f}`} className="inline-flex h-12 items-center gap-2 rounded-full px-4 font-medium uppercase hover:bg-sunken">
                <Download className="size-4" /> {f}
              </a>
            ))}
          </>
        }
      >
        <p className="mt-3 max-w-2xl text-ink-2">
          Worked out from the bills and tax payments in your taxation ledgers. Use it to check figures with your accountant; it is not a GST or TDS return.
        </p>
      </PageHeader>

      <PeriodTabs basePath="/reports/tax" active={period.key} from={params.from} to={params.to} extra={extra} />
      <div className="flex flex-wrap gap-2">
        <nav aria-label="Group by" className="flex gap-1 rounded-full bg-sunken p-1">
          {(["invoice", "payment"] as const).map((b) => (
            <Link
              key={b}
              href={`/reports/tax?${new URLSearchParams({ ...params, basis: b })}`}
              className={cn("inline-flex h-10 items-center rounded-full px-4 text-sm font-medium", basis === b ? "bg-ink text-surface" : "text-ink-2")}
            >
              {b === "invoice" ? "By invoice date" : "By entry date"}
            </Link>
          ))}
        </nav>
        {ledgers.length > 1 && (
          <form action="/reports/tax" className="flex gap-2">
            {Object.entries(params).filter(([k]) => k !== "ledger").map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <label htmlFor="tl" className="sr-only">Ledger</label>
            <select id="tl" name="ledger" defaultValue={ledgerId ?? ""} className="h-12 rounded-full bg-surface px-4 ring-1 ring-inset ring-line">
              <option value="">All taxation ledgers</option>
              {ledgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button type="submit" className="h-12 rounded-full px-4 font-medium ring-1 ring-inset ring-line">Show</button>
          </form>
        )}
      </div>

      {ledgers.length === 0 ? (
        <EmptyState title="No taxation ledgers yet" body="Create a taxation ledger to record bills with GST and TDS. They will be summarised here month by month." />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Totals">
            <div className="col-span-2 rounded-[var(--radius-card)] bg-lavender p-6">
              <div className="text-sm font-semibold">GST on bills</div>
              <Amount value={t.gst} size="xl" className="mt-6 block" />
              <div className="num mt-2 text-sm text-ink/70">
                CGST <Money value={t.cgst} /> · SGST <Money value={t.sgst} /> · IGST <Money value={t.igst} />
              </div>
            </div>
            <div className="rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70">
              <div className="text-sm font-medium text-ink-2">TDS withheld</div>
              <Amount value={t.tds} size="lg" className="mt-4 block text-[1.6rem] sm:text-[2rem]" />
              <div className="mt-1 text-[13px] text-ink-3">TDS paid <Money value={t.tdsPaid} /></div>
            </div>
            <div className="rounded-[var(--radius-card)] bg-ink p-5 text-seashell">
              <div className="text-sm opacity-75">GST not yet paid</div>
              <Amount value={summary.gstOutstanding} size="lg" className="mt-4 block text-[1.6rem] sm:text-[2rem]" />
              <div className="mt-1 text-[13px] opacity-70">GST paid <Money value={t.gstPaid} /></div>
            </div>
          </section>

          <div className="overflow-x-auto rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
            <table className="w-full min-w-[900px] text-right text-[14px]">
              <caption className="sr-only">Tax by month</caption>
              <thead className="bg-ink text-surface">
                <tr>
                  {["Month", "Bills", "Taxable", "CGST", "SGST", "IGST", "GST", "Gross", "TDS", "After TDS", "GST paid"].map((h, i) => (
                    <th key={h} scope="col" className={cn("px-3 py-3 font-medium", i === 0 && "pl-4 text-left")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="num divide-y divide-line">
                {summary.months.map((m) => (
                  <tr key={m.month}>
                    <th scope="row" className="py-3 pl-4 text-left font-medium">{monthLabel(m.month)}</th>
                    <td className="px-3">{m.invoices}</td>
                    {[m.taxable, m.cgst, m.sgst, m.igst, m.gst, m.gross, m.tds, m.net, m.gstPaid].map((v, i) => (
                      <td key={i} className="px-3"><Money value={v} /></td>
                    ))}
                  </tr>
                ))}
                {summary.months.length === 0 && (
                  <tr><td colSpan={11} className="p-6 text-left text-ink-2">No posted bills in this period.</td></tr>
                )}
              </tbody>
              {summary.months.length > 0 && (
                <tfoot className="num border-t-2 border-ink font-semibold">
                  <tr>
                    <th scope="row" className="py-3 pl-4 text-left">Total</th>
                    <td className="px-3">{t.invoices}</td>
                    {[t.taxable, t.cgst, t.sgst, t.igst, t.gst, t.gross, t.tds, t.net, t.gstPaid].map((v, i) => (
                      <td key={i} className="px-3"><Money value={v} /></td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {lines.length > 0 && (
            <section>
              <h2 className="display mb-3 text-2xl font-bold">Bills in this summary</h2>
              <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
                {lines.slice(0, 200).map((d) => (
                  <li key={d.transaction_id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[14px]">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{d.party || d.voucher_no}{d.invoice_no ? ` · Inv ${d.invoice_no}` : ""}</span>
                      <span className="block text-[13px] text-ink-3">{d.ledger} · {d.voucher_no} · {formatDate(d.invoice_date ?? d.txn_date)}</span>
                    </span>
                    <span className="num text-right">
                      <Money value={toPaise(d.taxable_amount)} /> + GST <Money value={toPaise(d.gst_amount)} /> − TDS <Money value={toPaise(d.tds_amount)} /> ={" "}
                      <Money value={toPaise(d.net_amount)} className="font-semibold" />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
