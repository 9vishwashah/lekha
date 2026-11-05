import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { listInvoices, listPayments } from "@/lib/server/invoices";
import { clientTotals, counted, invoiceReport, invoiceTotals, monthlyInvoiced, type InvoiceReportType } from "@/lib/invoices/reports";
import { STATUS_LABEL, balanceOf, invoiceStatus, type InvoiceStatus } from "@/lib/domain/invoice";
import { sum } from "@/lib/domain/money";
import { formatDate, monthLabel } from "@/lib/domain/dates";
import { ExportLink } from "@/components/app/export-link";
import { PeriodTabs, resolvePeriod } from "@/components/app/period-tabs";
import { Amount, Money } from "@/components/ui/amount";
import { PageHeader, SectionTitle } from "@/components/ui/bits";

export const metadata = { title: "Invoice reports" };

const REPORTS: { type: InvoiceReportType; title: string; hint: string }[] = [
  { type: "register", title: "Invoice register", hint: "Every issued invoice" },
  { type: "payments", title: "Payment collection", hint: "Each receipt, including reversals" },
  { type: "clients", title: "Client-wise invoicing", hint: "Invoiced and owed per client" },
  { type: "months", title: "Invoiced by month", hint: "Month on month" },
  { type: "overdue", title: "Overdue invoices", hint: "Past due with a balance" },
  { type: "tax", title: "Taxable summary", hint: "CGST, SGST and IGST charged" },
];

export default async function InvoiceReports(props: PageProps<"/invoices/reports">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const period = resolvePeriod(params, ctx.workspace.fy_start_month, "fy");
  const [rows, payments] = await Promise.all([listInvoices(ctx.db, ctx.workspace.id), listPayments(ctx.db, ctx.workspace.id)]);
  const totals = invoiceTotals(rows, period.range, period.today);
  const qs = new URLSearchParams({ ...(period.range.from && { from: period.range.from }), ...(period.range.to && { to: period.range.to }) }).toString();
  const months = monthlyInvoiced(rows, period.range);
  const clients = clientTotals(rows, period.range).slice(0, 10);
  const overdue = invoiceReport("overdue", rows, payments, period.range, period.today, ctx.workspace.name);
  const statuses = new Map<InvoiceStatus, number>();
  const inPeriod = rows.filter((i) => (!period.range.from || i.invoice_date >= period.range.from) && (!period.range.to || i.invoice_date <= period.range.to));
  for (const i of inPeriod) statuses.set(invoiceStatus(i, period.today), (statuses.get(invoiceStatus(i, period.today)) ?? 0) + 1);
  const pending = sum(inPeriod.filter(counted).map(balanceOf));

  return (
    <div className="flex flex-col gap-7">
      <Link href="/invoices" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Invoices
      </Link>
      <PageHeader title="Invoice reports" />
      <PeriodTabs basePath="/invoices/reports" active={period.key} from={params.from} to={params.to} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Invoiced", value: totals.invoiced, cls: "bg-ink text-seashell" },
          { label: "Received", value: totals.received, cls: "bg-green text-white" },
          { label: "Pending", value: pending, cls: "bg-lavender text-ink" },
          { label: "Overdue", value: totals.overdue, cls: "bg-red text-white" },
        ].map((t) => (
          <div key={t.label} className={`min-w-0 rounded-[var(--radius-card)] p-5 ${t.cls}`}>
            <div className="text-sm font-semibold">{t.label}</div>
            <Amount value={t.value} size="lg" className="mt-4 block truncate text-[1.5rem] sm:text-[1.9rem]" />
          </div>
        ))}
      </section>

      <section className="flex flex-wrap gap-2" aria-label="Invoices by status">
        {[...statuses.entries()].map(([s, n]) => (
          <span key={s} className="rounded-full bg-surface px-4 py-2 text-sm ring-1 ring-inset ring-line">
            {STATUS_LABEL[s]} · <span className="font-semibold">{n}</span>
          </span>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Download</SectionTitle>
        <ul className="grid gap-2 sm:grid-cols-2">
          {REPORTS.map((r) => (
            <li key={r.type} className="flex items-center gap-3 rounded-[24px] bg-surface p-4 ring-1 ring-inset ring-line/70">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{r.title}</div>
                <div className="text-[13px] text-ink-3">{r.hint}</div>
              </div>
              {(["xlsx", "csv", "pdf"] as const).map((f) => (
                <ExportLink key={f} href={`/api/export/invoices?type=${r.type}&format=${f}&${qs}`} className="inline-flex h-10 items-center gap-1 rounded-full px-2.5 text-sm font-medium uppercase hover:bg-sunken">
                  {f === "xlsx" ? <Download className="size-3.5" /> : null}
                  {f === "xlsx" ? "Excel" : f}
                </ExportLink>
              ))}
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-7 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <SectionTitle>By month</SectionTitle>
          {months.length === 0 ? (
            <p className="text-ink-2">Nothing issued in this period.</p>
          ) : (
            <ul className="divide-y divide-line rounded-[24px] bg-surface px-5 ring-1 ring-inset ring-line/70">
              {months.map(([m, v]) => (
                <li key={m} className="flex items-center justify-between gap-3 py-3 text-[15px]">
                  <span>
                    {monthLabel(m)} <span className="text-ink-3">· {v.count}</span>
                  </span>
                  <span className="text-right">
                    <Money value={v.invoiced} className="block font-semibold" />
                    <span className="text-[13px] text-ink-3">
                      received <Money value={v.received} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="flex flex-col gap-3">
          <SectionTitle>Top clients</SectionTitle>
          {clients.length === 0 ? (
            <p className="text-ink-2">Nothing issued in this period.</p>
          ) : (
            <ul className="divide-y divide-line rounded-[24px] bg-surface px-5 ring-1 ring-inset ring-line/70">
              {clients.map(([c, v]) => (
                <li key={c} className="flex items-center justify-between gap-3 py-3 text-[15px]">
                  <span className="min-w-0 truncate">{c}</span>
                  <span className="shrink-0 text-right">
                    <Money value={v.invoiced} className="block font-semibold" />
                    {v.balance > 0n && (
                      <span className="text-[13px] text-out">
                        owes <Money value={v.balance} />
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {overdue.rows.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionTitle>Overdue</SectionTitle>
          <ul className="divide-y divide-line rounded-[24px] bg-surface px-5 ring-1 ring-inset ring-line/70">
            {overdue.rows.map((r) => (
              <li key={String(r.invoice)} className="flex justify-between gap-3 py-3 text-[15px]">
                <span className="min-w-0 truncate">
                  {String(r.client)} <span className="text-ink-3">· {String(r.invoice)} · due {formatDate(String(r.due))}</span>
                </span>
                <Money value={r.balance as bigint} className="shrink-0 font-semibold text-out" />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
