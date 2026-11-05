/* eslint-disable @next/next/no-img-element -- logos and signatures are small public images */
import { formatINR } from "@/lib/domain/money";
import { formatDate, formatDateLong } from "@/lib/domain/dates";
import { TEMPLATE_STYLE, cellText, docColumns, metaRows, onColor, tint, totalRows, type InvoiceDoc } from "@/lib/invoices/doc";
import { qrPath } from "@/lib/invoices/qr";

export function QrCode({ value, size = 96, className }: { value: string; size?: number; className?: string }) {
  const { size: n, d } = qrPath(value);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} className={className} shapeRendering="crispEdges" role="img" aria-label="QR code">
      <path d={d} fill="#1d1d1b" />
    </svg>
  );
}

const PANEL = "#f4f2ef";

/**
 * The invoice as an A4 sheet in HTML, drawn from the same document the PDF uses. Fixed at 794 px
 * (A4 at 96 dpi) and scaled to fit by ScaledSheet, so a phone shows the same page as the PDF.
 */
export function InvoiceSheet({ doc }: { doc: InvoiceDoc }) {
  const style = TEMPLATE_STYLE[doc.template];
  const on = onColor(doc.brand);
  const cols = docColumns(doc);
  const weight = cols.reduce((a, c) => a + c.weight, 0);
  const totals = totalRows(doc);
  const facts = metaRows(doc).filter((r) => r.label !== "Invoice No." && r.label !== "Date");
  const body = style.dense ? "text-[12px]" : "text-[13px]";
  const p = doc.payment;
  const contact = [doc.seller.phone, doc.seller.email].filter(Boolean).join(" · ");
  const bank = p.bank
    ? [p.bank.holder && `Account holder: ${p.bank.holder}`, p.bank.name && `Bank: ${p.bank.name}`, p.bank.branch && `Branch: ${p.bank.branch}`, `Account no.: ${p.bank.account}`, p.bank.ifsc && `IFSC: ${p.bank.ifsc}`].filter(Boolean)
    : null;
  const other = [p.cash && "Cash accepted", p.cheque && `Cheques payable to ${p.bank?.holder ?? doc.seller.name}`, p.other, p.instructions].filter(Boolean);
  const panelLabel = { color: doc.brand };
  const project = doc.template === "project";
  const onAccent = onColor(doc.accent);
  const linkColor = project && doc.accent !== "#eac119" ? doc.accent : doc.brand;
  const label = (text: string) => (
    <div className="flex items-center gap-2.5">
      <span className="h-4 w-1" style={{ background: doc.brand }} />
      <span className="text-[10px] font-bold tracking-[0.22em]">{text.toUpperCase()}</span>
      <span className="h-px flex-1 bg-[#ddd9d0]" />
    </div>
  );

  return (
    <div className={`flex w-[794px] flex-col bg-white text-[#1d1d1b] ${body}`} style={{ minHeight: 1123, fontFamily: "var(--font-geist), Inter, sans-serif" }}>
      {project ? (
        <header className="px-[54px] pb-1">
          <div className="-mx-[54px] mb-5 h-5 w-[54%]" style={{ background: doc.brand }} />
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              {doc.seller.logo ? <img src={doc.seller.logo} alt="" className="max-h-20 max-w-[280px] object-contain" /> : <div className="text-[30px] font-semibold" style={{ color: doc.brand }}>{doc.seller.name}</div>}
            </div>
            <dl className="shrink-0 border-l-2 border-[#1d1d1b] pl-3 text-[12px] leading-relaxed">
              {[["Email :", doc.seller.email], ["Phone No:", doc.seller.phone], ["Address:", doc.seller.address], ["GSTIN:", doc.seller.gstin]]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="flex max-w-[300px] gap-1.5">
                    <dt className="shrink-0 font-semibold">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>
          </div>
          <div className="relative mt-4 h-[2px] bg-[#1d1d1b]">
            <span className="absolute -left-0.5 -top-[3px] size-2 rotate-45 bg-[#1d1d1b]" />
            <span className="absolute -right-0.5 -top-[3px] size-2 rotate-45 bg-[#1d1d1b]" />
          </div>
          <div className="mt-4 flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="text-[18px]">To,</div>
              <div className="text-[22px] font-semibold leading-tight">{doc.client.business || doc.client.name}</div>
              <div className="whitespace-pre-line text-[14px] leading-snug">
                {[doc.client.business && doc.client.business !== doc.client.name ? doc.client.name : null, doc.client.contact, doc.client.address, doc.client.gstin && `GSTIN: ${doc.client.gstin}`].filter(Boolean).join("\n")}
              </div>
            </div>
            <div className="shrink-0 text-[17px] font-semibold">Date: {formatDateLong(doc.date)}</div>
          </div>
          <h2 className="mt-4 text-center text-[22px] font-semibold">{doc.title ? `${doc.heading === "INVOICE" ? "Invoice" : doc.heading} - ${doc.title}` : doc.heading}</h2>
          <div className="mt-3 flex justify-between gap-4 text-[12px]">
            <span>
              <span className="mr-2 text-[9px] font-semibold tracking-[0.2em] text-[#5f5c52]">INVOICE NO.</span>
              <span className="font-semibold">{doc.number ?? "Assigned when issued"}</span>
            </span>
            {(doc.paymentTerms || doc.due || p.upi) && (
              <span className="w-[46%]">
                <span className="mr-2 text-[9px] font-semibold tracking-[0.2em] text-[#5f5c52]">PAYMENT</span>
                <span className="font-semibold" style={{ color: linkColor }}>
                  {[doc.paymentTerms ?? (doc.due ? `Due ${formatDate(doc.due)}` : null), p.upi ? "UPI" : p.bank ? "Bank transfer" : null].filter(Boolean).join(" · ")}
                </span>
              </span>
            )}
          </div>
        </header>
      ) : style.header === "band" ? (
        <header className="flex items-start justify-between px-[54px] pb-8 pt-8" style={{ background: doc.brand, color: on }}>
          <div className="min-w-0">
            {doc.seller.logo ? (
              <span className="inline-block bg-white p-1.5">
                <img src={doc.seller.logo} alt="" className="max-h-12 max-w-[130px] object-contain" />
              </span>
            ) : (
              <div className="text-[26px] font-semibold">{doc.seller.name}</div>
            )}
            <div className="mt-2 text-[11px] opacity-90">{contact}</div>
          </div>
          <div className="text-right">
            <div className="text-[30px] font-semibold leading-none">{doc.heading}</div>
            <div className="mt-2 text-[12px] opacity-90">{doc.number ?? "Number assigned when issued"}</div>
            <div className="text-[12px] opacity-90">{formatDate(doc.date)}</div>
          </div>
        </header>
      ) : (
        <header className={`flex items-start justify-between gap-6 px-[54px] pt-[48px] ${doc.logoRight ? "flex-row-reverse" : ""}`}>
          <div className={`min-w-0 ${doc.logoRight ? "text-right" : ""}`}>
            {doc.seller.logo ? (
              <img src={doc.seller.logo} alt="" className={`max-h-16 max-w-[200px] object-contain ${doc.logoRight ? "ml-auto" : ""}`} />
            ) : (
              <div className="text-[26px] font-semibold" style={{ color: doc.brand }}>
                {doc.seller.name}
              </div>
            )}
            <div className="mt-2 whitespace-pre-line text-[11px] leading-snug text-[#5f5c52]">
              {[doc.seller.address, contact, doc.seller.website, doc.seller.gstin && `GSTIN: ${doc.seller.gstin}`].filter(Boolean).join("\n")}
            </div>
          </div>
          <div className={doc.logoRight ? "" : "text-right"}>
            <div className="text-[30px] font-semibold leading-none" style={{ color: doc.brand }}>
              {doc.heading}
            </div>
            <div className="mt-2 text-[12px] text-[#5f5c52]">Invoice No.: {doc.number ?? "assigned when issued"}</div>
            <div className="text-[12px] text-[#5f5c52]">Date: {formatDate(doc.date)}</div>
          </div>
        </header>
      )}

      <div className="flex flex-1 flex-col gap-4 px-[54px] pb-6 pt-4">
        {style.header === "plain" && !project && <div className="h-[2px] w-full" style={{ background: doc.template === "minimal" ? "#ddd9d0" : doc.brand }} />}
        {project && label(doc.type === "project" ? "Deliverables" : "Details")}
        {style.header === "band" && (doc.seller.address || doc.seller.gstin) && (
          <div className="text-[11px] text-[#5f5c52]">{[doc.seller.address, doc.seller.gstin && `GSTIN ${doc.seller.gstin}`].filter(Boolean).join("  ·  ")}</div>
        )}

        {!project && (
        <section className="flex justify-between gap-6" style={style.panel ? { background: PANEL, padding: 16 } : undefined}>
          <div className="min-w-0 whitespace-pre-line">
            <div className="text-[10px] font-semibold tracking-wide" style={panelLabel}>
              BILL TO
            </div>
            <div className="mt-1 text-[15px] font-semibold">{doc.client.name}</div>
            <div className="leading-snug">
              {[
                doc.client.business !== doc.client.name ? doc.client.business : null,
                doc.client.contact && `Attn: ${doc.client.contact}`,
                doc.client.address,
                doc.client.state,
                doc.client.gstin && `GSTIN: ${doc.client.gstin}`,
              ]
                .filter(Boolean)
                .join("\n")}
            </div>
          </div>
          {facts.length > 0 && (
            <dl className="shrink-0 text-right text-[12px]">
              {facts.map((f) => (
                <div key={f.label} className="flex justify-end gap-3 py-0.5">
                  <dt className="text-[#5f5c52]">{f.label}</dt>
                  <dd className="font-semibold">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        )}

        {doc.title && !project && <h2 className="text-[15px] font-semibold">{doc.title}</h2>}

        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr style={style.table === "solid" ? { background: doc.brand, color: on } : { borderTop: "1px solid #1d1d1b", color: "#5f5c52" }}>
              {cols.map((c) => (
                <th key={c.key} style={{ width: `${(c.weight / weight) * 100}%`, textAlign: c.align }} className="px-2 py-2.5 text-[10px] font-semibold uppercase tracking-wide">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {doc.items.map((item, idx) => (
              <tr key={item.n} className={`align-top ${style.zebra ? "" : "border-b border-[#e3e0d9]"}`} style={style.zebra && idx % 2 ? { background: tint(doc.brand) } : undefined}>
                {cols.map((c) => (
                  <td key={c.key} className="break-words px-2 py-2.5 leading-snug" style={{ textAlign: c.align, color: c.key === "n" ? doc.brand : undefined, fontWeight: c.key === "n" || c.key === "item" || c.key === "amount" ? 600 : 400 }}>
                    {cellText(item, c.key)}
                    {c.key === "item" && item.url && <div className="break-all text-[11px] font-normal" style={{ color: linkColor }}>{item.url}</div>}
                    {c.key === "item" && doc.type !== "project" && item.description && <div className="whitespace-pre-line text-[12px] font-normal text-[#5f5c52]">{item.description}</div>}
                    {c.key === "item" && item.sku && <div className="text-[11px] font-normal text-[#5f5c52]">SKU {item.sku}</div>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <section className="flex flex-col items-end gap-1">
          {totals.map((r) => (
            <div key={r.label} className="flex w-[42%] justify-between px-2">
              <span className="text-[#5f5c52]">{r.label}</span>
              <span>{r.value}</span>
            </div>
          ))}
          {style.total === "band" ? (
            <div className="mt-1 flex w-full items-center justify-between px-4 py-3" style={{ background: doc.accent, color: onAccent }}>
              <span className="text-[12px] font-semibold tracking-[0.2em]">TOTAL PAYABLE</span>
              <span className="text-[22px] font-semibold">{formatINR(doc.grand)}</span>
            </div>
          ) : (
            <div className="mt-1 flex w-[44%] items-center justify-between px-3 py-2.5" style={{ background: PANEL }}>
              <span className="text-[12px] font-semibold">GRAND TOTAL</span>
              <span className="text-[15px] font-semibold">{formatINR(doc.grand)}</span>
            </div>
          )}
        </section>
        <p className="text-[11px] text-[#5f5c52]">Amount in words: {doc.words}</p>
        {doc.notes && <p className="whitespace-pre-line text-[12px] text-[#5f5c52]">{doc.notes}</p>}

        {(bank || other.length > 0 || doc.terms) && (
          <section className="grid grid-cols-2 gap-3">
            {(bank || other.length > 0) && (
              <div className="p-3.5" style={{ background: PANEL }}>
                <div className="mb-1.5 text-[10px] font-semibold tracking-wide" style={panelLabel}>
                  {bank ? "BANK DETAILS" : "PAYMENT"}
                </div>
                <div className="whitespace-pre-line leading-snug">{(bank ?? other).join("\n")}</div>
                {bank && other.length > 0 && <div className="mt-1.5 whitespace-pre-line leading-snug text-[#5f5c52]">{other.join("\n")}</div>}
              </div>
            )}
            {doc.terms && (
              <div className="p-3.5" style={{ background: PANEL }}>
                <div className="mb-1.5 text-[10px] font-semibold tracking-wide" style={panelLabel}>
                  TERMS &amp; CONDITIONS
                </div>
                <div className="whitespace-pre-line leading-snug">{doc.terms}</div>
              </div>
            )}
          </section>
        )}

        {project && p.upi && label("Pay via UPI")}
        {project && p.upi ? (
          <section className="flex items-center gap-6 rounded-xl border p-4" style={{ borderColor: doc.brand }}>
            <div className="shrink-0">{p.upi.link ? <QrCode value={p.upi.link} size={130} /> : p.upi.qrImage ? <img src={p.upi.qrImage} alt="" className="size-[130px] object-contain" /> : null}</div>
            <div className="min-w-0 flex-1">
              <div className="text-[9px] font-bold tracking-[0.2em]" style={panelLabel}>
                PAYMENT MODE
              </div>
              <div className="text-[17px] font-semibold">UPI</div>
              <div className="mt-2 text-[9px] font-bold tracking-[0.2em]" style={panelLabel}>
                {p.upi.number ? "UPI NUMBER" : "UPI ID"}
              </div>
              <div className="break-all text-[17px] font-semibold">{p.upi.number ?? p.upi.id}</div>
              {p.upi.payee && <div className="text-[12px] text-[#5f5c52]">{p.upi.payee}</div>}
              <div className="mt-1 text-[12px] text-[#5f5c52]">Scan the QR or pay to the number.</div>
              {doc.paymentTerms && (
                <div className="mt-1 text-[9px] font-bold tracking-[0.2em]" style={panelLabel}>
                  {doc.paymentTerms.toUpperCase()}
                </div>
              )}
            </div>
            {doc.digitalUrl && (
              <div className="shrink-0 text-center text-[10px] text-[#5f5c52]">
                <QrCode value={doc.digitalUrl} size={92} />
                <div className="mt-1">Digital copy</div>
              </div>
            )}
          </section>
        ) : (p.upi || doc.digitalUrl) && (
          <section className="grid grid-cols-2 gap-3">
            {p.upi && (
              <div className="flex items-center gap-3 p-3" style={{ background: PANEL }}>
                <div className="bg-white p-1">
                  {p.upi.link ? <QrCode value={p.upi.link} size={84} /> : p.upi.qrImage ? <img src={p.upi.qrImage} alt="" className="size-[84px] object-contain" /> : null}
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold tracking-wide" style={panelLabel}>
                    PAY BY UPI
                  </div>
                  <div className="text-[12px]">Scan with any UPI app to pay.</div>
                  {p.upi.id && <div className="break-all text-[12px]">UPI ID: {p.upi.id}</div>}
                  {p.upi.number && <div className="text-[12px]">Number: {p.upi.number}</div>}
                </div>
              </div>
            )}
            {doc.digitalUrl && (
              <div className="flex items-center gap-3 p-3" style={{ background: PANEL }}>
                <div className="bg-white p-1">
                  <QrCode value={doc.digitalUrl} size={84} />
                </div>
                <div>
                  <div className="text-[10px] font-semibold tracking-wide" style={panelLabel}>
                    DIGITAL COPY
                  </div>
                  <div className="text-[12px]">Scan to view or download this invoice.</div>
                </div>
              </div>
            )}
          </section>
        )}

        {(doc.seller.signatoryName || doc.seller.signature || doc.seller.stamp) && (
          <section className="mt-1 flex flex-col items-end text-right">
            <div>Authorized Signatory</div>
            {(doc.seller.signature || doc.seller.stamp) && (
              <div className="my-1 flex items-center gap-1">
                {doc.seller.signature && <img src={doc.seller.signature} alt="" className="max-h-14 max-w-[120px] object-contain" />}
                {doc.seller.stamp && <img src={doc.seller.stamp} alt="" className="max-h-14 max-w-[120px] object-contain" />}
              </div>
            )}
            {doc.seller.signatoryName && <div className="font-semibold">{doc.seller.signatoryName}</div>}
            {doc.seller.signatoryTitle && <div className="text-[11px] text-[#5f5c52]">{doc.seller.signatoryTitle}</div>}
          </section>
        )}

        <footer className="mt-auto flex justify-between border-t border-[#e3e0d9] pt-2 text-[10px] text-[#5f5c52]">
          <span>{doc.footer || contact}</span>
        </footer>
      </div>
      {project && <div className="ml-auto h-5 w-[66%]" style={{ background: doc.accent }} />}
    </div>
  );
}
