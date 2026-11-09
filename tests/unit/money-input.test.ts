import { describe, expect, it } from "vitest";
import { amountInWords, groupIndian, plainAmount } from "@/components/ui/field";

describe("amount field", () => {
  it("groups the Indian way while typing", () => {
    expect(groupIndian("1")).toBe("1");
    expect(groupIndian("1000")).toBe("1,000");
    expect(groupIndian("117000")).toBe("1,17,000");
    expect(groupIndian("1170000")).toBe("11,70,000");
    expect(groupIndian("12345678")).toBe("1,23,45,678");
    expect(groupIndian("1170000.5")).toBe("11,70,000.5");
    expect(groupIndian("1170000.")).toBe("11,70,000.");
    expect(groupIndian("-250000")).toBe("-2,50,000");
    expect(groupIndian("")).toBe("");
  });

  it("keeps only the plain number for saving, whatever was typed or pasted", () => {
    expect(plainAmount("11,70,000")).toBe("1170000");
    expect(plainAmount("₹ 1,17,000.509")).toBe("117000.50");
    expect(plainAmount("007")).toBe("7");
    expect(plainAmount("0.5")).toBe("0.5");
    expect(plainAmount("1.2.3")).toBe("1.23");
    expect(plainAmount("-5,000")).toBe("-5000");
    expect(plainAmount("abc")).toBe("");
  });

  it("names big amounts in lakh and crore", () => {
    expect(amountInWords("99999")).toBe("");
    expect(amountInWords("100000")).toBe("1 lakh");
    expect(amountInWords("1170000")).toBe("11.7 lakh");
    expect(amountInWords("12500000")).toBe("1.25 crore");
    expect(amountInWords("-250000")).toBe("2.5 lakh");
  });
});
