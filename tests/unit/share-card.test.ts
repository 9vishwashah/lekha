import { describe, expect, it, vi } from "vitest";
import type { SharedPayload } from "@/lib/server/shared";

vi.mock("server-only", () => ({}));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), clerkClient: vi.fn() }));

const { shareMessage, summarizeShare, whatsappNumber } = await import("@/lib/server/share-card");

const txn = (seq: number, direction: "in" | "out", amount: string) => ({
  seq,
  voucher_no: `BL-${seq}`,
  date: "2026-10-01",
  txn_date: "2026-10-01",
  status: "posted" as const,
  direction,
  amount,
  kind: "regular" as const,
  is_cash: true,
  affects_party: true,
  description: null,
  counterparty: null,
});

const party = (show_balance = true): SharedPayload => ({
  ledger: {
    name: "Ramesh site",
    ledger_type: "basic",
    perspective: "party",
    contractor_name: "Ramesh Saini",
    opening_balance: "0",
    opening_balance_date: null,
    last_activity_at: "2026-10-20T10:00:00Z",
  },
  options: { show_balance, show_running_balance: true, show_tax: false, show_reference: false, show_counterparty: true },
  transactions: [txn(1, "out", "150000"), txn(2, "in", "33000")] as SharedPayload["transactions"],
  participants: null,
  shared_expenses: null,
  settlements: null,
});

const card = { color: "tea", shared_by: "Vishwa Shah", business: "VJAS" };

describe("share link preview", () => {
  it("writes the balance for the recipient, naming the sender instead of 'you'", () => {
    const s = summarizeShare(party(), card);
    expect(s.headline).toBe("Ramesh Saini owes Vishwa");
    expect(s.amount).toBe("₹1,17,000");
    expect(s.color).toBe("tea");
    expect(s.chips[0]).toBe("2 entries");
  });

  it("never states a balance the link hides", () => {
    const s = summarizeShare(party(false), card);
    expect(s.amount).toBeNull();
    expect(JSON.stringify(s)).not.toContain("1,17,000");
  });

  it("greets the person by first name and signs with the sender", () => {
    const msg = shareMessage(summarizeShare(party(), card), "https://lekha.example/s/tok", false);
    expect(msg.startsWith("Hi Ramesh,")).toBe(true);
    expect(msg).toContain("*Ramesh site* from VJAS");
    expect(msg).toContain("*₹1,17,000*");
    expect(msg).toContain("https://lekha.example/s/tok");
    expect(msg.trim().endsWith("Vishwa Shah")).toBe(true);
  });

  it("turns saved phones into WhatsApp numbers", () => {
    expect(whatsappNumber("98765 43210")).toBe("919876543210");
    expect(whatsappNumber("098765-43210")).toBe("919876543210");
    expect(whatsappNumber("+91 98765 43210")).toBe("919876543210");
    expect(whatsappNumber("+44 7700 900123")).toBe("447700900123");
    expect(whatsappNumber("12345")).toBeNull();
    expect(whatsappNumber(null)).toBeNull();
  });
});
