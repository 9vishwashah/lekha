import { describe, expect, it } from "vitest";
import { fullName, mobile } from "@/lib/validation/profile";

describe("profile fields", () => {
  it.each([
    ["98765 43210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["(987) 654-3210", "+919876543210"],
    ["+44 7911 123456", "+447911123456"],
  ])("accepts %s as %s", (input, expected) => {
    expect(mobile.parse(input)).toBe(expected);
  });

  it.each(["12345", "5876543210", "abcdefghij", "+91 12345 67890", ""])("rejects %j", (input) => {
    expect(mobile.safeParse(input).success).toBe(false);
  });

  it("needs a real name", () => {
    expect(fullName.safeParse(" V ").success).toBe(false);
    expect(fullName.parse("  Vishwa Shah ")).toBe("Vishwa Shah");
  });
});
