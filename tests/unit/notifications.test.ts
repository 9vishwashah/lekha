import { describe, expect, it } from "vitest";
import { describeNotification, type NotificationRow } from "@/lib/notifications";

const n = (x: Partial<NotificationRow>): NotificationRow => ({ id: 1, kind: "entry", actor_name: "Dhiraj Saini", subject: "Site cash", amount: "5000.00", direction: "in", detail: null, href: null, created_at: "2026-11-12T10:00:00Z", read_at: null, ...x });

describe("notification wording", () => {
  it("money in and out read from the reader's side, in rupees", () => {
    expect(describeNotification(n({})).title).toBe("Dhiraj Saini added ₹5,000 money in");
    expect(describeNotification(n({ direction: "out", amount: 120050.5 })).title).toBe("Dhiraj Saini added ₹1,20,050.50 money out");
    expect(describeNotification(n({})).body).toBe("Site cash");
  });

  it("reminders and confirmations", () => {
    expect(describeNotification(n({ kind: "invoice_overdue", subject: "Invoice ED/001", actor_name: "Regal", amount: "900", detail: "Was due 10 Jan 2026" })).title).toBe("Invoice ED/001 is overdue");
    expect(describeNotification(n({ kind: "confirmed", actor_name: "Ramesh" })).title).toBe("Ramesh confirmed the statement");
    expect(describeNotification(n({ kind: "joined", actor_name: "Anil Kumar", detail: "@anilk", subject: "Anil" })).body).toContain("@anilk");
  });
});
