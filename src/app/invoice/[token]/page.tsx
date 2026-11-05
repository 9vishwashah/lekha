/* eslint-disable @next/next/no-img-element -- business logos are small public images */
import type { Metadata } from "next";
import { Eye, Mail, MessageCircle, Phone } from "lucide-react";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { loadInvoiceCard, loadPublicInvoice, publicDoc } from "@/lib/server/invoices";
import { STATUS_LABEL, type InvoiceStatus, invoiceTypeLabel } from "@/lib/domain/invoice";
import { formatINR, toDecimal, toPaise } from "@/lib/domain/money";
import { formatDate, todayISO } from "@/lib/domain/dates";
import { paymentModeLabel } from "@/lib/types";
import { brandUrl, totalRows, onColor } from "@/lib/invoices/doc";
import { whatsappNumber } from "@/lib/whatsapp";
import { QrCode } from "@/components/app/invoice/invoice-sheet";
import { Logo } from "@/components/app/logo";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";
import { ClaimButton, CopyRow, DownloadButton, ViewBeacon } from "./client";

// Always rendered per request: the balance must be current, and access can be revoked at any time.
export const dynamic = "force-dynamic";

const base: Metadata = { title: "Invoice", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** Who sent it and which invoice. Link previews never carry the amount or the client's name. */
export async function generateMetadata(props: PageProps<"/invoice/[token]">): Promise<Metadata> {
  const { token } = await props.params;
  const card = await loadInvoiceCard(token);
  if (!card) return base;
  const business = card.business ?? "Lekha";
  const title = `Invoice ${card.invoice_no} from ${business}`;
  const description = `View your invoice from ${business}, with payment details.`;
  return { ...base, title, description, openGraph: { title, description, siteName: business, type: "website" }, twitter: { card: "summary_large_image", title, description } };
}

function Unavailable({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4">
      <Logo />
      <h1 className="display text-5xl font-extrabold">{title}</h1>
      <p className="text-lg text-ink-2">{body}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 sm:p-6">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

export default async function PublicInvoice(props: PageProps<"/invoice/[token]">) {
  const { token } = await props.params;
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  if (!allow(await clientKey("invoice-page"), 60, 60_000)) return <Unavailable title="Too many requests" body="Wait a minute and refresh the page." />;
  const invoice = await loadPublicInvoice(token);
  if (!invoice) return <Unavailable title="This link is no longer active" body="Ask the business that sent it for a new link." />;

  const doc = publicDoc(invoice, token);
  const status = invoice.status as InvoiceStatus;
  const paid = status === "paid";
  const proforma = doc.type === "proforma";
  const card = invoice.card_color ?? doc.brand;
  const on = onColor(card);
  const clientLogo = brandUrl(invoice.client.logo_path);
  const today = todayISO();
  const p = doc.payment;
  const original = invoice.files.find((f) => f.role === "original");
  const mode = invoice.document_mode;
  const viewable = original && (original.mime_type === "application/pdf" || original.mime_type.startsWith("image/"));
  const fileHref = original ? `/api/invoice/${token}/file/${original.n}` : "";
  // Only the issuer's own document: the page is a cover for it, so its summary lines are not listed.
  const documentOnly = mode === "uploaded" && Boolean(original);
  const supporting = invoice.files.filter((f) => f.role !== "original");
  const phone = whatsappNumber(doc.seller.phone);
  const canClaim = invoice.allow_payment_claims && !paid && !proforma;
  const hasDetails = p.upi || p.bank || p.cash || p.cheque || p.other || p.instructions;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 overflow-x-clip px-4 pb-12 pt-[max(1rem,env(safe-area-inset-top))]">
      <ViewBeacon token={token} />
      <header className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[15px] font-semibold">{doc.seller.name}</span>
        <span className="shrink-0 rounded-full bg-sunken px-3 py-1.5 text-[13px] font-medium">{proforma ? "Proforma" : STATUS_LABEL[status]}</span>
      </header>

      <section className="rounded-[32px] p-6 sm:p-8" style={{ background: card, color: on }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium opacity-80">
              {doc.heading} · {doc.number}
            </div>
            {doc.title && <h1 className="display mt-1 text-2xl font-bold">{doc.title}</h1>}
          </div>
          {doc.seller.logo && <img src={doc.seller.logo} alt={doc.seller.name} className="h-14 max-w-[112px] shrink-0 rounded-2xl bg-white object-contain p-1.5 sm:h-16 sm:max-w-[140px]" />}
        </div>
        <div className="mt-8 text-[15px] font-semibold">{paid ? "Paid in full" : proforma ? "Estimated total" : doc.received > 0n ? "Balance due" : "Amount due"}</div>
        <div className="num display text-[3.2rem] font-extrabold leading-none sm:text-7xl">{formatINR(paid ? doc.grand : doc.balance)}</div>
        <div className="mt-2 text-[14px] opacity-80">
          {paid ? "Thank you" : doc.due ? `${status === "overdue" ? "Was due" : "Due"} ${formatDate(doc.due)}` : `Dated ${formatDate(doc.date)}`}
        </div>
        <dl className="mt-6 grid grid-cols-3 gap-3 border-t pt-4 text-[13px]" style={{ borderColor: `${on}33` }}>
          <div>
            <dt className="opacity-75">Total</dt>
            <dd className="num font-semibold">{formatINR(doc.grand)}</dd>
          </div>
          <div>
            <dt className="opacity-75">Paid</dt>
            <dd className="num font-semibold">{formatINR(doc.received)}</dd>
          </div>
          <div>
            <dt className="opacity-75">Balance</dt>
            <dd className="num font-semibold">{formatINR(doc.balance)}</dd>
          </div>
        </dl>
      </section>

      <div className="grid gap-2 sm:grid-cols-2">
        {original && mode !== "lekha" && (
          viewable ? (
            <a href={`${fileHref}?view=1`} target="_blank" rel="noopener noreferrer" className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-full bg-ink px-5 text-[15px] font-semibold text-surface">
              <Eye className="size-4" /> {original.mime_type === "application/pdf" ? "View PDF" : "View invoice"}
            </a>
          ) : (
            <DownloadButton href={fileHref} label="Download invoice" primary />
          )
        )}
        {mode !== "uploaded" && <DownloadButton href={`/api/invoice/${token}/pdf`} label={mode === "both" ? "Download summary PDF" : "Download invoice PDF"} primary={mode === "lekha" || !original} />}
        {original && mode === "lekha" && <DownloadButton href={fileHref} label="Download attached document" />}
        {canClaim && <ClaimButton token={token} balance={toDecimal(doc.balance)} today={today} />}
      </div>

      {invoice.pending_claims > 0 && !paid && (
        <p className="rounded-3xl bg-mustard/30 p-4 text-[15px] font-medium">Your payment note is waiting for the business to confirm it.</p>
      )}

      <Section title="Billed to">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-lg font-semibold">{doc.client.name}</div>
            <div className="whitespace-pre-line text-[15px] text-ink-2">
              {[doc.client.business !== doc.client.name ? doc.client.business : null, doc.client.address, doc.client.gstin && `GSTIN ${doc.client.gstin}`].filter(Boolean).join("\n")}
            </div>
          </div>
          {clientLogo && <img src={clientLogo} alt="" className="h-12 max-w-[96px] shrink-0 rounded-xl bg-white object-contain p-1 ring-1 ring-inset ring-line" />}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-[14px]">
          <div>
            <dt className="text-ink-3">Invoice date</dt>
            <dd className="font-medium">{formatDate(doc.date)}</dd>
          </div>
          {doc.due && (
            <div>
              <dt className="text-ink-3">Due date</dt>
              <dd className="font-medium">{formatDate(doc.due)}</dd>
            </div>
          )}
          {doc.paymentTerms && (
            <div>
              <dt className="text-ink-3">Payment terms</dt>
              <dd className="font-medium">{doc.paymentTerms}</dd>
            </div>
          )}
          {doc.placeOfSupply && (
            <div>
              <dt className="text-ink-3">Place of supply</dt>
              <dd className="font-medium">{doc.placeOfSupply}</dd>
            </div>
          )}
        </dl>
      </Section>

      {!paid && hasDetails && (
        <Section title="How to pay">
          {p.upi && (
            <div className="flex flex-col items-center gap-3 border-b border-line pb-4 sm:flex-row sm:items-start sm:gap-5">
              <div className="rounded-2xl bg-white p-2.5 ring-1 ring-inset ring-line">
                {p.upi.link ? <QrCode value={p.upi.link} size={200} /> : p.upi.qrImage ? <img src={p.upi.qrImage} alt="UPI QR code" className="size-[200px] object-contain" /> : null}
              </div>
              <div className="w-full min-w-0 flex-1">
                <div className="font-semibold">Pay by UPI</div>
                <p className="text-[14px] text-ink-2">
                  Scan with any UPI app{p.upi.link ? ` for ${formatINR(doc.balance)}` : ""}. It starts a payment; the business confirms it once received.
                </p>
                {p.upi.id && <CopyRow label="UPI ID" value={p.upi.id} />}
                {p.upi.number && <CopyRow label="UPI number" value={p.upi.number} />}
                {p.upi.link && (
                  <a href={p.upi.link} className="mt-1 inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-5 font-semibold text-surface sm:hidden">
                    Open in UPI app
                  </a>
                )}
              </div>
            </div>
          )}
          {p.bank && (
            <div className="divide-y divide-line">
              {p.bank.holder && <CopyRow label="Account holder" value={p.bank.holder} />}
              <CopyRow label="Account number" value={p.bank.account} />
              {p.bank.ifsc && <CopyRow label="IFSC" value={p.bank.ifsc} />}
              {p.bank.name && (
                <div className="py-2.5">
                  <div className="text-[13px] text-ink-3">Bank</div>
                  <div className="text-[15px] font-semibold">{[p.bank.name, p.bank.branch].filter(Boolean).join(", ")}</div>
                </div>
              )}
            </div>
          )}
          {[p.cash && "Cash accepted", p.cheque && `Cheques payable to ${p.bank?.holder ?? doc.seller.name}`, p.other, p.instructions].filter(Boolean).map((line) => (
            <p key={String(line)} className="mt-2 whitespace-pre-line text-[15px]">
              {line}
            </p>
          ))}
        </Section>
      )}

      {!documentOnly && (
      <Section title={doc.type === "project" ? "Deliverables" : doc.type === "custom" ? "Details" : invoiceTypeLabel(doc.type)}>
        <ul className="divide-y divide-line">
          {doc.items.map((i) => (
            <li key={i.n} className="flex items-start justify-between gap-4 py-3 first:pt-0">
              <div className="min-w-0">
                <div className="font-semibold">{i.name}</div>
                {i.url && <div className="break-all text-[13px] text-ink-2">{i.url}</div>}
                {i.description && <p className="mt-0.5 whitespace-pre-line text-[14px] text-ink-2">{i.description}</p>}
                <div className="mt-0.5 text-[13px] text-ink-3">
                  {[i.quantity !== "1" || i.unit ? `${i.quantity}${i.unit ? ` ${i.unit}` : ""} × ${formatINR(i.rate)}` : null, i.hsn && `HSN/SAC ${i.hsn}`, doc.gst && `GST ${i.taxRate}%`].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="num shrink-0 font-semibold">{formatINR(i.amount)}</div>
            </li>
          ))}
        </ul>
        <dl className="mt-2 flex flex-col gap-1 border-t border-line pt-3 text-[15px]">
          {totalRows(doc).map((r) => (
            <div key={r.label} className="flex justify-between">
              <dt className="text-ink-2">{r.label}</dt>
              <dd className="num">{r.value}</dd>
            </div>
          ))}
          <div className="flex justify-between text-lg font-bold">
            <dt>Total</dt>
            <dd className="num">{formatINR(doc.grand)}</dd>
          </div>
        </dl>
        <p className="mt-1 text-[13px] text-ink-3">{doc.words}</p>
      </Section>
      )}

      {invoice.payments.length > 0 && (
        <Section title="Payments received">
          <ul className="divide-y divide-line">
            {invoice.payments.map((x, i) => (
              <li key={i} className="flex justify-between gap-3 py-2.5 text-[15px]">
                <span>
                  {formatDate(x.paid_on)}
                  {x.mode && <span className="text-ink-3"> · {paymentModeLabel(x.mode)}</span>}
                </span>
                <span className="num font-semibold text-in">{formatINR(toPaise(x.amount))}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {supporting.length > 0 && (
        <Section title="Attachments">
          <div className="grid gap-2">
            {supporting.map((f) => (
              <DownloadButton key={f.n} href={`/api/invoice/${token}/file/${f.n}`} label={f.file_name} />
            ))}
          </div>
        </Section>
      )}

      {(doc.notes || doc.terms) && (
        <Section title="Notes and terms">
          {doc.notes && <p className="whitespace-pre-line text-[15px]">{doc.notes}</p>}
          {doc.terms && <p className="mt-2 whitespace-pre-line text-[14px] text-ink-2">{doc.terms}</p>}
        </Section>
      )}

      {(doc.seller.phone || doc.seller.email) && (
        <Section title={`Contact ${doc.seller.name}`}>
          <div className="flex flex-wrap gap-2">
            {phone && (
              <a href={`https://wa.me/${phone}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-12 items-center gap-2 rounded-full bg-sunken px-5 font-medium">
                <MessageCircle className="size-4" /> WhatsApp
              </a>
            )}
            {doc.seller.phone && (
              <a href={`tel:${doc.seller.phone.replace(/\s/g, "")}`} className="inline-flex h-12 items-center gap-2 rounded-full bg-sunken px-5 font-medium">
                <Phone className="size-4" /> Call
              </a>
            )}
            {doc.seller.email && (
              <a href={`mailto:${doc.seller.email}`} className="inline-flex h-12 items-center gap-2 rounded-full bg-sunken px-5 font-medium">
                <Mail className="size-4" /> Email
              </a>
            )}
          </div>
        </Section>
      )}

      <footer className="mt-4 flex items-center justify-center gap-2 text-[13px] text-ink-3">
        Sent with <Logo compact />
      </footer>
    </div>
  );
}
