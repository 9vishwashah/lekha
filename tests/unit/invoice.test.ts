import { describe, expect, it } from "vitest";
import {
  amountInWords,
  computeInvoice,
  formatInvoiceNumber,
  fyLabel,
  invoiceReminderMessage,
  invoiceShareMessage,
  invoiceStatus,
  reminderStageFor,
  upiLink,
} from "@/lib/domain/invoice";
import { toPaise } from "@/lib/domain/money";
import { formatDateLong } from "@/lib/domain/dates";
import { DOCX, checkUpload, downloadName, sniffMime } from "@/lib/invoices/files";
import { invoiceReport, invoiceTotals } from "@/lib/invoices/reports";
import { onColor, tint } from "@/lib/invoices/doc";
import { whatsappLink, whatsappNumber } from "@/lib/whatsapp";
import type { InvoiceListRow } from "@/lib/server/invoices";

const base = { lines: [] as { quantity: string; rate: string; discount_percent?: string; tax_rate?: string }[], gstEnabled: false, discountKind: "amount" as const, discountValue: "", roundOff: false };

describe("invoice calculations", () => {
  it("adds lines with quantities and rates", () => {
    const c = computeInvoice({ ...base, lines: [{ quantity: "3", rate: "333.33" }, { quantity: "1.5", rate: "1000" }] });
    expect(c.subtotal).toBe(toPaise("2499.99"));
    expect(c.grand).toBe(toPaise("2499.99"));
    expect(c.supply).toBe("none");
  });

  it("applies a line discount, then an invoice discount, once each", () => {
    const c = computeInvoice({ ...base, lines: [{ quantity: "1", rate: "1000", discount_percent: "10" }, { quantity: "1", rate: "1000" }], discountKind: "percent", discountValue: "10" });
    expect(c.subtotal).toBe(toPaise("1900"));
    expect(c.discount).toBe(toPaise("190"));
    expect(c.grand).toBe(toPaise("1710"));
  });

  it("shares an invoice discount across lines without losing a paisa", () => {
    const c = computeInvoice({ ...base, lines: [{ quantity: "1", rate: "100" }, { quantity: "1", rate: "100" }, { quantity: "1", rate: "100" }], discountValue: "100" });
    expect(c.lines.map((l) => l.taxable).reduce((a, b) => a + b)).toBe(toPaise("200"));
  });

  it("never lets a discount exceed the bill", () => {
    expect(computeInvoice({ ...base, lines: [{ quantity: "1", rate: "100" }], discountValue: "500" }).grand).toBe(0n);
  });

  it("splits GST within a state and uses IGST across states", () => {
    const line = [{ quantity: "1", rate: "1000", tax_rate: "18" }];
    const intra = computeInvoice({ ...base, lines: line, gstEnabled: true, sellerState: "27", placeOfSupply: "27" });
    expect([intra.supply, intra.cgst, intra.sgst, intra.igst]).toEqual(["intra", toPaise("90"), toPaise("90"), 0n]);
    const inter = computeInvoice({ ...base, lines: line, gstEnabled: true, sellerState: "27", placeOfSupply: "29" });
    expect([inter.supply, inter.cgst, inter.sgst, inter.igst]).toEqual(["inter", 0n, 0n, toPaise("180")]);
    expect(inter.grand).toBe(toPaise("1180"));
  });

  it("taxes the discounted amount, and ignores tax rates when GST is off", () => {
    const c = computeInvoice({ ...base, lines: [{ quantity: "1", rate: "1000", tax_rate: "18" }], gstEnabled: true, sellerState: "27", placeOfSupply: "27", discountValue: "100" });
    expect(c.tax).toBe(toPaise("162"));
    expect(computeInvoice({ ...base, lines: [{ quantity: "1", rate: "1000", tax_rate: "18" }] }).tax).toBe(0n);
  });

  it("rounds the total and shows the adjustment", () => {
    const c = computeInvoice({ ...base, lines: [{ quantity: "1", rate: "99.49" }], roundOff: true });
    expect(c.grand).toBe(toPaise("99"));
    expect(c.rounding).toBe(-49n);
  });

  it("does not break on half-typed numbers", () => {
    expect(computeInvoice({ ...base, lines: [{ quantity: "", rate: "abc" }, { quantity: "2.", rate: "." }] }).grand).toBe(0n);
  });
});

describe("amount in words", () => {
  it.each([
    ["425000", "Four Lakh Twenty Five Thousand Rupees Only"],
    ["5500", "Five Thousand Five Hundred Rupees Only"],
    ["1", "One Rupee Only"],
    ["1170000", "Eleven Lakh Seventy Thousand Rupees Only"],
    ["12500000", "One Crore Twenty Five Lakh Rupees Only"],
    ["100.50", "One Hundred Rupees and Fifty Paise Only"],
    ["0.75", "Seventy Five Paise Only"],
    ["0", "Zero Rupees Only"],
  ])("%s", (amount, words) => {
    expect(amountInWords(toPaise(amount))).toBe(words);
  });
});

describe("status", () => {
  const row = { status: "issued" as const, invoice_type: "service", grand_total: "1000", amount_received: "0", due_date: "2026-11-01", sent_at: null, first_viewed_at: null };

  it("follows the money and the dates", () => {
    expect(invoiceStatus({ ...row, status: "draft", sent_at: "x" }, "2026-10-01")).toBe("draft");
    expect(invoiceStatus(row, "2026-10-01")).toBe("issued");
    expect(invoiceStatus({ ...row, sent_at: "x" }, "2026-10-01")).toBe("sent");
    expect(invoiceStatus({ ...row, first_viewed_at: "x" }, "2026-10-01")).toBe("viewed");
    expect(invoiceStatus({ ...row, amount_received: "1" }, "2026-10-01")).toBe("partial");
    expect(invoiceStatus(row, "2026-11-02")).toBe("overdue");
  });

  it("a paid invoice is never overdue, and a cancelled one is never owed", () => {
    expect(invoiceStatus({ ...row, amount_received: "1000" }, "2027-01-01")).toBe("paid");
    expect(invoiceStatus({ ...row, status: "cancelled" }, "2027-01-01")).toBe("cancelled");
    expect(invoiceStatus({ ...row, invoice_type: "proforma" }, "2027-01-01")).toBe("issued");
  });

  it("picks the reminder for the day", () => {
    expect(reminderStageFor("2026-11-01", "2026-10-30")).toBe("before_due");
    expect(reminderStageFor("2026-11-01", "2026-11-01")).toBe("on_due");
    expect(reminderStageFor("2026-11-01", "2026-11-09")).toBe("after_due");
    expect(reminderStageFor(null, "2026-11-09")).toBe("custom");
  });
});

describe("numbers and dates", () => {
  it("formats invoice numbers", () => {
    expect(formatInvoiceNumber({ format: "{PREFIX}/{FY}/{SEQ}", prefix: "LEKHA/INV", padding: 3 }, "2026-27", "2026-10-02", 1)).toBe("LEKHA/INV/2026-27/001");
    expect(formatInvoiceNumber({ format: "{SEQ}/{MM}/{YYYY}", prefix: "", padding: 3 }, "x", "2026-10-02", 11)).toBe("011/10/2026");
  });

  it("works out the financial year", () => {
    expect(fyLabel("2026-04-01")).toBe("2026-27");
    expect(fyLabel("2027-03-31")).toBe("2026-27");
  });

  it("writes formal dates", () => {
    expect(formatDateLong("2026-10-24")).toBe("24th October 2026");
    expect(formatDateLong("2026-11-01")).toBe("1st November 2026");
    expect(formatDateLong("2026-11-22")).toBe("22nd November 2026");
    expect(formatDateLong("2026-11-13")).toBe("13th November 2026");
  });
});

describe("sharing", () => {
  it("builds a valid, encoded UPI link", () => {
    const link = upiLink({ id: "9221757111@ybl", payee: "Asha & Co", amount: toPaise("425000.50"), note: "Invoice 011/Oct/26" });
    const q = new URL(link.replace("upi://pay", "https://x.test/")).searchParams;
    expect(link.startsWith("upi://pay?pa=9221757111%40ybl")).toBe(true);
    expect(link).not.toContain("+");
    expect(q.get("pn")).toBe("Asha and Co");
    expect(q.get("am")).toBe("425000.50");
    expect(q.get("cu")).toBe("INR");
    expect(q.get("tn")).toBe("Invoice 011 Oct 26");
  });

  it("sends only person-to-person fields, so a personal UPI ID is not treated as a merchant", () => {
    const q = new URL(upiLink({ id: "someone@okaxis", payee: "VJAS", amount: toPaise("100"), note: "Invoice 1" }).replace("upi://pay", "https://x.test/")).searchParams;
    expect([...q.keys()].sort()).toEqual(["am", "cu", "pa", "pn", "tn"]);
    expect(q.has("tr")).toBe(false);
    expect(q.has("mc")).toBe(false);
  });

  it("leaves the amount out when none is set", () => {
    expect(upiLink({ id: "a@b" })).not.toContain("am=");
  });

  it("writes the WhatsApp message from the invoice and encodes it", () => {
    const text = invoiceShareMessage({ clientName: "Sumit", business: "VJAS & Co", invoiceNo: "INV/001", total: toPaise("5500"), dueDate: "2026-11-19", url: "https://lekha.test/invoice/abc" });
    expect(text).toContain("Hi Sumit,");
    expect(text).toContain("Please find your invoice from VJAS & Co.");
    expect(text).toContain("Amount: ₹5,500");
    expect(text).toContain("Thank you for your business!");
    const url = new URL(whatsappLink(text, whatsappNumber("98765 43210")));
    expect(url.pathname).toBe("/919876543210");
    expect(url.searchParams.get("text")).toBe(text);
  });

  it("reminds for what is outstanding, not the invoice total", () => {
    const text = invoiceReminderMessage({ clientName: "Sumit", invoiceNo: "INV/001", outstanding: toPaise("1500"), dueDate: "2026-11-01", url: "u", stage: "after_due" });
    expect(text).toContain("for ₹1,500");
    expect(text).toContain("was due on");
  });
});

describe("uploaded files", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const pdf = new TextEncoder().encode("%PDF-1.7 rest");
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);
  const jpg = bytes(0xff, 0xd8, 0xff, 0xe0);
  const docx = new TextEncoder().encode("PK\x03\x04....[Content_Types].xml....word/document.xml");

  it("recognises files from their content", () => {
    expect(sniffMime(pdf)).toBe("application/pdf");
    expect(sniffMime(png)).toBe("image/png");
    expect(sniffMime(jpg)).toBe("image/jpeg");
    expect(sniffMime(docx)).toBe(DOCX);
  });

  it("rejects what is not an invoice document", () => {
    expect(checkUpload("a.pdf", new TextEncoder().encode("MZ executable"))).toMatchObject({ ok: false });
    expect(checkUpload("a.docx", new TextEncoder().encode("PK\x03\x04 some other zip"))).toMatchObject({ ok: false });
    expect(checkUpload("a.pdf", new Uint8Array(0))).toMatchObject({ ok: false });
    expect(checkUpload("a.pdf", new Uint8Array(5 * 1024 * 1024))).toMatchObject({ ok: false });
  });

  it("rejects a file whose name lies about its content", () => {
    expect(checkUpload("invoice.pdf", png)).toMatchObject({ ok: false });
    expect(checkUpload("photo.jpeg", jpg)).toMatchObject({ ok: true, mime: "image/jpeg" });
  });

  it("makes download names safe for a header", () => {
    expect(downloadName('in"voice\r\n.pdf')).toBe("in_voice__.pdf");
  });
});

describe("reports reconcile", () => {
  const row = (over: Partial<InvoiceListRow>): InvoiceListRow =>
    ({ id: "1", status: "issued", invoice_type: "service", invoice_no: "1", invoice_date: "2026-10-01", due_date: "2026-10-15", client_name: "A", client_business: null, grand_total: "1000", amount_received: "0", tax_total: "0", taxable_total: "1000", cgst_total: "0", sgst_total: "0", igst_total: "0", sent_at: null, first_viewed_at: null, ...over }) as InvoiceListRow;
  const rows = [
    row({ id: "1", amount_received: "400" }),
    row({ id: "2", grand_total: "500", amount_received: "500" }),
    row({ id: "3", status: "draft", invoice_no: null }),
    row({ id: "4", status: "cancelled" }),
    row({ id: "5", invoice_type: "proforma" }),
    row({ id: "6", due_date: null, grand_total: "200", amount_received: "300" }),
  ];

  it("invoiced = received + outstanding, leaving out drafts, cancelled and proformas", () => {
    const t = invoiceTotals(rows, {}, "2026-11-01");
    expect(t.invoiced).toBe(toPaise("1700"));
    expect(t.received).toBe(toPaise("1100")); // an overpayment never inflates this
    expect(t.outstanding).toBe(toPaise("600"));
    expect(t.received + t.outstanding).toBe(t.invoiced);
    expect(t.overdue).toBe(toPaise("600"));
    expect(t.drafts).toBe(1);
  });

  it("exports the same totals as the screen", () => {
    const table = invoiceReport("register", rows, [], {}, "2026-11-01", "VJAS");
    expect(table.rows).toHaveLength(3);
    expect(table.totals?.total).toBe(toPaise("1700"));
  });
});

describe("colours", () => {
  it("picks readable text on a brand colour", () => {
    expect(onColor("#29306f")).toBe("#ffffff");
    expect(onColor("#eac119")).toBe("#1d1d1b");
  });

  it("makes a pale row tint", () => {
    expect(tint("#000000", 0.1)).toBe("#e6e6e6");
  });
});
