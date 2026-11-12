import { describe, expect, it } from "vitest";
import { invoiceEmail, monthlyStatementEmail, monthlySummaryEmail, paymentReminderEmail } from "@/lib/email/templates";

describe("email templates", () => {
  it("payment reminder: amount in rupees, the message, the statement button and a plain-text part", () => {
    const e = paymentReminderEmail({ business: "DHIRAJ ENTERPRISES", sender: "Vishwa Shah", clientName: "Ramesh Saini", balance: 7585800n, note: "By Friday please", statementUrl: "https://lekha.test/s/abc" });
    expect(e.subject).toBe("Reminder: ₹75,858 pending to DHIRAJ ENTERPRISES");
    expect(e.html).toContain("₹75,858");
    expect(e.html).toContain("https://lekha.test/s/abc");
    expect(e.text).toContain("Hi Ramesh,");
    expect(e.text).toContain("By Friday please");
  });

  it("escapes names and messages so they can't inject HTML", () => {
    const e = paymentReminderEmail({ business: "<b>Evil</b> & Co", sender: "x", clientName: "A", balance: 100n, note: '<script>alert("x")</script>' });
    expect(e.html).not.toContain("<script>");
    expect(e.html).not.toContain("<b>Evil</b>");
    expect(e.html).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp; Co");
  });

  it("monthly statement reads the right way round", () => {
    expect(monthlyStatementEmail({ business: "B", ownerName: null, clientName: "C", balance: 50000n, month: "2026-10" }).subject).toBe("October 2026 statement from B: ₹500 due");
    expect(monthlyStatementEmail({ business: "B", ownerName: null, clientName: "C", balance: -50000n, month: "2026-10" }).html).toContain("B owes you");
  });

  it("summary and invoice", () => {
    const s = monthlySummaryEmail({ name: "Vishwa", workspace: "W", month: "2026-10", owedToYou: 100000n, youOwe: 2500n, top: [{ name: "Goodwill", balance: 100000n }], appUrl: "https://x.test" });
    expect(s.text).toContain("People owe you: ₹1,000");
    const i = invoiceEmail({ business: "VJAS", sender: "V", clientName: "Regal Impex", invoiceNo: "INV/1", total: 2950000n, balance: 2000000n, dueDate: "2026-11-30", url: "https://x.test/invoice/t" });
    expect(i.subject).toBe("Invoice INV/1 from VJAS · ₹20,000");
    expect(i.text).toContain("Still due: ₹20,000");
  });
});
