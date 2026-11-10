import { describe, expect, it } from "vitest";
import { matchesSearch } from "@/lib/domain/search";

const iphone = { description: "iPhone 17", counterparty: "SURAJ SAINI", reference_no: null, voucher_no: "BL-0066", amount: 78981.34 };
const gst = { description: null, counterparty: null, reference_no: null, voucher_no: "TX-0010", amount: "180000.00" };

describe("ledger search", () => {
  it("never throws on number amounts or missing fields (the crash on ?q=iphone)", () => {
    expect(() => matchesSearch(iphone, "iphone")).not.toThrow();
    expect(() => matchesSearch({ amount: 5 }, "x")).not.toThrow();
    expect(() => matchesSearch({}, "100")).not.toThrow();
  });

  it("finds words in any case", () => {
    expect(matchesSearch(iphone, "iphone")).toBe(true);
    expect(matchesSearch(iphone, "suraj")).toBe(true);
    expect(matchesSearch(iphone, "bl-0066")).toBe(true);
    expect(matchesSearch(iphone, "anil")).toBe(false);
  });

  it("finds amounts typed with or without commas, ₹ or paise", () => {
    expect(matchesSearch(iphone, "78981")).toBe(true);
    expect(matchesSearch(iphone, "78,981")).toBe(true);
    expect(matchesSearch(iphone, "₹78,981.34")).toBe(true);
    expect(matchesSearch(gst, "1,80,000")).toBe(true);
    expect(matchesSearch(gst, "180000")).toBe(true);
    expect(matchesSearch(gst, "90000")).toBe(false);
  });

  it("an empty search matches everything", () => {
    expect(matchesSearch(gst, "  ")).toBe(true);
  });
});
