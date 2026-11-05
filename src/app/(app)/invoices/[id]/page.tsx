import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { getInvoice, getInvoiceSettings, invoiceLink, listPaymentProfiles, recordOf } from "@/lib/server/invoices";
import { isUuid } from "@/lib/server/queries";
import { docFromRecord } from "@/lib/invoices/doc";
import { previewPayment } from "@/lib/invoices/editor";
import { STATUS_LABEL, STATUS_TONE, balanceOf, invoiceStatus, invoiceTypeLabel, reminderStageFor } from "@/lib/domain/invoice";
import { formatINR, toPaise } from "@/lib/domain/money";
import { formatDate, formatDateTime, relativeTime, todayISO } from "@/lib/domain/dates";
import { Amount } from "@/components/ui/amount";
import { Badge, SectionTitle } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { InvoiceSheet } from "@/components/app/invoice/invoice-sheet";
import { ScaledSheet } from "@/components/app/invoice/scaled-sheet";
import { DraftActions, FilesPanel, InvoiceActions, LinkPanel, PaymentHistory, SubmissionsPanel } from "./client";

export const metadata = { title: "Invoice" };

const EVENT: Record<string, string> = {
  created: "Draft created",
  edited: "Draft edited",
  issued: "Invoice issued",
  amended: "Notes or due date amended",
  shared: "Shared on WhatsApp",
  viewed: "Opened by the client",
  reminder: "Reminder sent",
  payment_recorded: "Payment recorded",
  payment_reversed: "Payment reversed",
  claim_submitted: "Client said they paid",
  claim_confirmed: "Client payment confirmed",
  claim_rejected: "Client payment not received",
  cancelled: "Invoice cancelled",
  link_rotated: "New link created",
  link_revoked: "Link turned off",
  attachment_added: "File attached",
  attachment_removed: "File removed",
  attachment_shared: "File shared with the client",
  attachment_hidden: "File hidden from the client",
};

export default async function InvoiceDetail(props: PageProps<"/invoices/[id]">) {
  const ctx = await getWorkspace();
  const { id } = await props.params;
  const params = (await props.searchParams) as Record<string, string>;
  if (!isUuid(id)) notFound();
  const data = await getInvoice(ctx.db, id);
  if (!data || data.invoice.workspace_id !== ctx.workspace.id) notFound();
  const { invoice: i, items, payments, submissions, attachments, events, reminders, link } = data;
  const today = todayISO();
  const [settings, profiles, url] = await Promise.all([
    getInvoiceSettings(ctx.db, ctx.workspace.id, ctx.workspace.name),
    ctx.canWrite ? listPaymentProfiles(ctx.db, ctx.workspace.id) : Promise.resolve([]),
    ctx.canWrite && i.status === "issued" ? invoiceLink(ctx.db, id) : Promise.resolve(null),
  ]);
  const seller = i.seller_snapshot ?? settings;
  const payment = i.payment_snapshot ?? previewPayment(i.payment_config, profiles);
  const doc = docFromRecord(recordOf(i, items, seller, payment), i.show_digital_qr ? url : null);
  const status = invoiceStatus(i, today);
  const balance = balanceOf(i);
  const proforma = i.invoice_type === "proforma";
  const open = i.status === "issued" && !proforma && balance > 0n;
  const ledger = i.ledger_id ? (await ctx.db.from("ledgers").select("id, name").eq("id", i.ledger_id).maybeSingle()).data : null;
  const excess = toPaise(i.amount_received) - toPaise(i.grand_total);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/invoices" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Invoices
      </Link>

      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink-2">{i.source === "uploaded" ? "Uploaded invoice" : invoiceTypeLabel(i.invoice_type)}</span>
          <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
        </div>
        <h1 className="display break-words text-[2.2rem] font-extrabold leading-none sm:text-5xl">{i.invoice_no ?? "Draft invoice"}</h1>
        <p className="text-[15px] text-ink-2">
          {i.client_business || i.client_name || "No client yet"} · {formatDate(i.invoice_date)}
          {i.due_date ? ` · due ${formatDate(i.due_date)}` : ""}
          {i.title ? ` · ${i.title}` : ""}
        </p>
      </header>

      {i.status === "cancelled" && (
        <p className="rounded-3xl bg-sunken p-4 text-[15px]">
          Cancelled {i.cancelled_at ? formatDateTime(i.cancelled_at) : ""}: {i.cancel_reason}. It no longer counts as owed, and its link does not open.
        </p>
      )}
      {proforma && i.status === "issued" && <p className="rounded-3xl bg-pink/40 p-4 text-[15px]">A proforma is an estimate. It posts nothing to ledgers and takes no payments. Convert it to an invoice when the work is confirmed.</p>}

      <section aria-label="Amounts" className="grid grid-cols-3 gap-2 sm:gap-3">
        {[
          { label: "Total", value: toPaise(i.grand_total), cls: "bg-ink text-seashell" },
          { label: "Received", value: toPaise(i.amount_received), cls: "bg-green text-white" },
          { label: "Balance", value: balance, cls: status === "overdue" ? "bg-red text-white" : "bg-lavender text-ink" },
        ].map((t) => (
          <div key={t.label} className={`min-w-0 rounded-[24px] p-4 sm:p-5 ${t.cls}`}>
            <div className="text-[13px] font-semibold">{t.label}</div>
            <Amount value={t.value} size="lg" className="mt-3 block truncate text-[1.15rem] sm:text-[1.9rem]" />
          </div>
        ))}
      </section>
      {excess > 0n && <p className="-mt-3 text-sm font-medium">{formatINR(excess)} was received over the invoice total.</p>}

      {ctx.canWrite && i.status === "draft" && (
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`/invoices/${id}/edit`} size="lg">
            <Pencil className="size-4" /> Continue editing
          </LinkButton>
          <DraftActions id={id} />
        </div>
      )}
      {ctx.canWrite && i.status === "issued" && (
        <InvoiceActions
          invoice={{ id, no: i.invoice_no!, proforma, open, balance: balance.toString(), total: i.grand_total, received: i.amount_received, due: i.due_date, phone: i.client_phone, clientName: i.client_contact || i.client_name || "there", business: doc.seller.name, notes: i.notes ?? "", terms: i.terms ?? "", showQr: i.show_digital_qr, allowClaims: i.allow_payment_claims, showHistory: i.show_payment_history }}
          url={url}
          today={today}
          suggested={reminderStageFor(i.due_date, today)}
          lastReminder={i.last_reminder_at}
          autoOpen={params.do}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <a href={`/api/invoices/${id}/pdf`} className="inline-flex h-12 items-center rounded-full bg-surface px-5 font-medium ring-1 ring-inset ring-line">
          Download PDF
        </a>
        <a href={`/api/invoices/${id}/pdf?inline=1`} target="_blank" rel="noopener noreferrer" className="inline-flex h-12 items-center rounded-full px-5 font-medium hover:bg-sunken">
          Open PDF pages
        </a>
        {ledger && (
          <Link href={`/ledgers/${ledger.id}`} className="inline-flex h-12 items-center rounded-full px-5 font-medium hover:bg-sunken">
            Ledger: {ledger.name}
          </Link>
        )}
      </div>

      {submissions.filter((s) => s.status === "pending").length > 0 && <SubmissionsPanel invoiceId={id} canWrite={ctx.canWrite} items={submissions.filter((s) => s.status === "pending")} balance={balance.toString()} />}

      {i.status !== "draft" && (
        <section className="flex flex-col gap-3">
          <SectionTitle>Payment history</SectionTitle>
          <PaymentHistory invoiceId={id} payments={payments} canWrite={ctx.canWrite} />
        </section>
      )}

      {ctx.canWrite && i.status === "issued" && (
        <section className="flex flex-col gap-3">
          <SectionTitle>Share link</SectionTitle>
          <LinkPanel id={id} url={url} link={link} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <SectionTitle>Documents</SectionTitle>
        <FilesPanel id={id} files={attachments} canWrite={ctx.canWrite && i.status !== "cancelled"} draft={i.status === "draft"} source={i.source} />
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{i.source === "uploaded" ? "Companion page" : "Preview"}</SectionTitle>
        <div className="max-w-3xl overflow-hidden rounded-2xl ring-1 ring-line">
          <ScaledSheet>
            <InvoiceSheet doc={doc} />
          </ScaledSheet>
        </div>
      </section>

      {reminders.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionTitle>Reminders</SectionTitle>
          <ul className="divide-y divide-line rounded-[24px] bg-surface px-5 ring-1 ring-inset ring-line/70">
            {reminders.map((r) => (
              <li key={r.id} className="flex justify-between gap-3 py-3 text-[15px]">
                <span>{formatDateTime(r.created_at)}</span>
                <span className="num font-medium">{formatINR(toPaise(r.outstanding))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <SectionTitle>Timeline</SectionTitle>
        <ul className="flex flex-col gap-2">
          {events.map((e) => (
            <li key={e.id} className="flex justify-between gap-3 text-[14px]">
              <span>{EVENT[e.event] ?? e.event}</span>
              <span className="shrink-0 text-ink-3">{relativeTime(e.created_at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
