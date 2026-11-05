import { writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { docFromDraft, type DraftForm, type PaymentSnapshot, type SellerSnapshot } from "@/lib/invoices/doc";
import { TEMPLATES } from "@/lib/domain/invoice";

vi.mock("server-only", () => ({}));
const { invoicePdf } = await import("@/lib/invoices/pdf");

const seller: SellerSnapshot = {
  business_name: "Sample Studio",
  email: "hello@sample.test",
  phone: "+91 90000 00000",
  address: "12 Sample Road, Mumbai 400001",
  gst_registered: true,
  gstin: "27ABCDE1234F1Z5",
  state_code: "27",
  signatory_name: "Asha Rao",
  signatory_title: "Director",
  brand_color: "#29306f",
  accent_color: "#eac119",
};

const payment: PaymentSnapshot = {
  upi: { id: "sample@ybl", payee: "Sample Studio", number: "9000000000", dynamic: true },
  bank: { holder: "Sample Studio", name: "Sample Bank", branch: "Fort", account: "1234567890", ifsc: "SBIN0001234" },
  cheque: true,
};

const item = (name: string, description = "", rate = "1000") => ({ name, description, reference_url: "", sku: "", hsn: "9983", quantity: "1", unit: "", rate, discount_percent: "", tax_rate: "18" });

const form = (over: Partial<DraftForm>): DraftForm => ({
  invoice_type: "service",
  invoice_no: "INV/2026-27/001",
  title: "",
  invoice_date: "2026-11-05",
  due_date: "2026-11-19",
  payment_terms: "Net 14",
  template: "modern",
  client_name: "Client Name",
  client_business: "Client Business Pvt Ltd",
  client_contact: "",
  client_address: "Road 1\nCity 400001",
  client_gstin: "",
  client_state: "Maharashtra",
  client_country: "India",
  place_of_supply: "27",
  gst_enabled: false,
  discount_kind: "amount",
  discount_value: "",
  charge_label: "",
  charge_amount: "",
  round_off: false,
  notes: "Thank you.",
  terms: "Payment due within 14 days.",
  footer: "",
  items: [item("Consultancy services", "Professional consultancy rendered in connection with documentation.", "425000")],
  ...over,
});

const long = "Long description that has to wrap across several lines without ever being clipped by the table cell it sits in. ".repeat(8);

describe("invoice PDF", () => {
  it.each(TEMPLATES.map((t) => t.value))("renders the %s template with a digital copy QR", async (template) => {
    const doc = docFromDraft(form({ template }), seller, payment, null);
    doc.digitalUrl = `https://lekha.test/invoice/${"a".repeat(43)}`;
    const bytes = await invoicePdf(doc);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeLessThanOrEqual(2);
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/${template}.pdf`, bytes);
  });

  it("flows long invoices across pages without losing lines", async () => {
    const items = Array.from({ length: 45 }, (_, i) => item(`Deliverable ${i + 1}`, i % 3 ? "Short note" : long));
    const doc = docFromDraft(form({ invoice_type: "project", template: "project", title: "Website rebuild", items }), seller, payment, null);
    doc.digitalUrl = `https://lekha.test/invoice/${"a".repeat(43)}`;
    const bytes = await invoicePdf(doc);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(2);
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/long.pdf`, bytes);
  });

  it("lays out a project invoice like the branded reference", async () => {
    const items = [
      { ...item("Company Website", "Responsive business website with home, product categories, enquiry form, one-tap WhatsApp and call buttons, location and contact.", "2000"), reference_url: "sample.test" },
      { ...item("Brand Website", "Premium site for one product: hero with price, origin story, recipe pages and an order on WhatsApp flow.", "2000"), reference_url: "sample.test/brand" },
      { ...item("Link Page + Search Visibility", "Mobile link page with logo and buttons, page titles and descriptions, preview images and verification.", "1000"), reference_url: "sample.test/links" },
      { ...item("Creative Posts", "Branded creative posts designed in the brand look, ready to post.", "500"), reference_url: "Social media" },
    ];
    const doc = docFromDraft(
      form({ invoice_type: "project", template: "project", title: "Sample Website", client_business: "SAMPLE TRADERS", client_name: "Mr. Sample", client_address: "", payment_terms: "Due on receipt", terms: "", notes: "Includes mobile-first design, SSL, domain connection and hosting setup.", items }),
      { ...seller, gst_registered: false, signatory_name: null, signatory_title: null, brand_color: "#4a2a7b", accent_color: "#14532d" },
      { upi: { id: "sample@ybl", payee: "Asha Rao", number: "+91 90000 00000", dynamic: true } },
      null,
    );
    doc.digitalUrl = `https://lekha.test/invoice/${"a".repeat(43)}`;
    const bytes = await invoicePdf(doc);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/project-sample.pdf`, bytes);
  });

  it("renders a GST invoice and survives one enormous description", async () => {
    const doc = docFromDraft(form({ invoice_type: "gst", template: "tax", client_gstin: "27AAAAA0000A1Z5", place_of_supply: "29", items: [item("Service", "Word ".repeat(1500)), item("Support")] }), seller, payment, null);
    const bytes = await invoicePdf(doc);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
    expect(doc.supply).toBe("inter");
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/gst.pdf`, bytes);
  });
});
