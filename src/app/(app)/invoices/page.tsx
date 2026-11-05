import Link from "next/link";
import { BarChart3, Plus, Settings2 } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { listInvoices, pendingClaims } from "@/lib/server/invoices";
import { invoiceTotals } from "@/lib/invoices/reports";
import { STATUS_LABEL, STATUS_TONE, balanceOf, invoiceStatus, invoiceTypeLabel, INVOICE_TYPES } from "@/lib/domain/invoice";
import { toPaise } from "@/lib/domain/money";
import { formatDateShort, relativeTime } from "@/lib/domain/dates";
import { PeriodTabs, resolvePeriod } from "@/components/app/period-tabs";
import { FilterChips } from "@/components/app/pending-nav";
import { IntentLink } from "@/components/app/intent-link";
import { Amount, Money } from "@/components/ui/amount";
import { Badge, EmptyState, PageHeader } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { InvoiceRowMenu } from "./row-menu";

export const metadata = { title: "Invoices" };

const FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "sent", label: "Sent" },
  { key: "viewed", label: "Viewed" },
  { key: "unpaid", label: "Unpaid" },
  { key: "partial", label: "Partially paid" },
  { key: "paid", label: "Paid" },
  { key: "overdue", label: "Overdue" },
  { key: "cancelled", label: "Cancelled" },
];

export default async function InvoicesPage(props: PageProps<"/invoices">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const period = resolvePeriod(params, ctx.workspace.fy_start_month, "fy");
  const [rows, claims] = await Promise.all([listInvoices(ctx.db, ctx.workspace.id), pendingClaims(ctx.db, ctx.workspace.id)]);
  const totals = invoiceTotals(rows, period.range, period.today);
  const show = FILTERS.some((f) => f.key === params.show) ? params.show : "all";
  const q = (params.q ?? "").trim().toLowerCase();
  const type = params.type ?? "";

  const visible = rows.filter((i) => {
    const s = invoiceStatus(i, period.today);
    const unpaid = i.status === "issued" && i.invoice_type !== "proforma" && balanceOf(i) > 0n;
    const matches =
      show === "all" ||
      (show === "unpaid" ? unpaid : show === "partial" ? unpaid && toPaise(i.amount_received) > 0n : show === "sent" ? ["sent", "viewed"].includes(s) : s === show);
    const inRange = (!period.range.from || i.invoice_date >= period.range.from) && (!period.range.to || i.invoice_date <= period.range.to);
    const text = !q || [i.invoice_no, i.title, i.client_name, i.client_business].some((v) => v?.toLowerCase().includes(q));
    return matches && inRange && text && (!type || i.invoice_type === type);
  });

  const qs = (extra: Record<string, string>) => {
    const keep = Object.fromEntries(Object.entries(params).filter(([k]) => k !== "show"));
    return `/invoices?${new URLSearchParams({ ...keep, ...extra })}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoices"
        actions={
          <>
            <Link href="/invoices/reports" className="inline-flex h-12 items-center gap-2 rounded-full px-4 font-medium hover:bg-sunken">
              <BarChart3 className="size-4" /> Reports
            </Link>
            <Link href="/invoices/settings" className="inline-flex h-12 items-center gap-2 rounded-full px-4 font-medium hover:bg-sunken">
              <Settings2 className="size-4" /> Settings
            </Link>
            {ctx.canWrite && (
              <LinkButton href="/invoices/new">
                <Plus className="size-5" /> Create invoice
              </LinkButton>
            )}
          </>
        }
      >
        <p className="mt-2 text-ink-2">Create, share and track your client invoices.</p>
      </PageHeader>

      <PeriodTabs basePath="/invoices" active={period.key} from={params.from} to={params.to} extra={params.show ? { show: params.show } : {}} />

      {claims > 0 && (
        <Link href="/invoices?show=unpaid" className="rounded-3xl bg-mustard p-4 font-medium text-ink">
          {claims === 1 ? "A client says they have paid." : `${claims} clients say they have paid.`} Open the invoice to confirm it against your account.
        </Link>
      )}

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: "Total invoiced", value: totals.invoiced, cls: "bg-ink text-seashell", note: `${totals.count} issued · ${period.label.toLowerCase()}` },
          { label: "Total received", value: totals.received, cls: "bg-green text-white", note: "On these invoices" },
          { label: "Outstanding", value: totals.outstanding, cls: "bg-lavender text-ink", note: "Still to come in" },
          { label: "Overdue", value: totals.overdue, cls: "bg-red text-white", note: "Past the due date" },
        ].map((t) => (
          <div key={t.label} className={`flex min-h-32 min-w-0 flex-col justify-between rounded-[var(--radius-card)] p-5 ${t.cls}`}>
            <span className="text-sm font-semibold">{t.label}</span>
            <span className="min-w-0">
              <Amount value={t.value} size="lg" className="block truncate text-[1.5rem] sm:text-[1.9rem]" />
              <span className="block truncate text-[13px] opacity-80">{t.note}</span>
            </span>
          </div>
        ))}
        <Link href={qs({ show: "draft" })} className="col-span-2 flex min-h-20 items-center justify-between rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 lg:col-span-1 lg:min-h-32 lg:flex-col lg:items-start">
          <span className="text-sm font-semibold">Drafts</span>
          <span className="num display text-3xl font-extrabold">{totals.drafts}</span>
        </Link>
      </section>
      <p className="-mt-3 text-[13px] text-ink-3">Totals leave out drafts, cancelled invoices and proformas. Invoiced = received + outstanding.</p>

      <div className="flex flex-col gap-3">
        <form action="/invoices" className="flex flex-col gap-2 sm:flex-row">
          {Object.entries(params)
            .filter(([k]) => !["q", "type"].includes(k))
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <label htmlFor="iq" className="sr-only">
            Search invoices
          </label>
          <input
            id="iq"
            name="q"
            defaultValue={params.q}
            placeholder="Search number, client or title"
            className="h-12 min-w-0 flex-1 rounded-full bg-surface px-5 text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink"
          />
          <div className="flex gap-2">
            <label htmlFor="itype" className="sr-only">
              Invoice type
            </label>
            <select id="itype" name="type" defaultValue={type} className="h-12 min-w-0 flex-1 rounded-full bg-surface px-4 text-sm ring-1 ring-inset ring-line">
              <option value="">Any type</option>
              {INVOICE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button type="submit" className="h-12 rounded-full bg-ink px-5 font-medium text-surface">
              Search
            </button>
          </div>
        </form>
        <FilterChips label="Filter invoices" active={show} items={FILTERS.map((f) => ({ key: f.key, href: qs(f.key === "all" ? {} : { show: f.key }), label: f.label }))} />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "Create your first invoice" : "Nothing matches"}
          body={rows.length === 0 ? "Make a branded invoice here, or upload one you already have. Share it on WhatsApp and track what comes in." : "Try another filter or date range."}
          action={rows.length === 0 && ctx.canWrite ? <LinkButton href="/invoices/new">Create invoice</LinkButton> : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((i) => {
            const s = invoiceStatus(i, period.today);
            const open = i.status === "issued" && i.invoice_type !== "proforma" && balanceOf(i) > 0n;
            return (
              <li key={i.id} className="flex items-stretch gap-1 rounded-[24px] bg-surface ring-1 ring-inset ring-line/70">
                <IntentLink href={i.status === "draft" && ctx.canWrite ? `/invoices/${i.id}/edit` : `/invoices/${i.id}`} className="flex min-w-0 flex-1 flex-col gap-2 rounded-l-[24px] p-4 hover:bg-white sm:flex-row sm:items-center sm:gap-4 sm:p-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{i.client_business || i.client_name || "No client yet"}</span>
                      <Badge tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</Badge>
                    </div>
                    <div className="truncate text-[13px] text-ink-3">
                      {[i.invoice_no ?? "No number yet", i.title, i.source === "uploaded" ? "Uploaded" : invoiceTypeLabel(i.invoice_type)].filter(Boolean).join(" · ")}
                    </div>
                    <div className="truncate text-[13px] text-ink-3">
                      {formatDateShort(i.invoice_date, period.today)}
                      {i.due_date ? ` · due ${formatDateShort(i.due_date, period.today)}` : ""} · updated {relativeTime(i.updated_at)}
                    </div>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 sm:block sm:text-right">
                    <Money value={toPaise(i.grand_total)} className="text-[17px] font-bold" />
                    {open && toPaise(i.amount_received) > 0n && (
                      <div className="text-[13px] text-ink-2">
                        Received <Money value={toPaise(i.amount_received)} />
                      </div>
                    )}
                    {open && (
                      <div className="text-[13px] font-medium text-out">
                        Balance <Money value={balanceOf(i)} />
                      </div>
                    )}
                  </div>
                </IntentLink>
                <InvoiceRowMenu
                  id={i.id}
                  status={i.status}
                  canWrite={ctx.canWrite}
                  canPay={open}
                  message={{ clientName: i.client_name ?? "there", invoiceNo: i.invoice_no ?? "", total: i.grand_total, dueDate: i.due_date, phone: i.client_phone, proforma: i.invoice_type === "proforma", business: ctx.workspace.name }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
