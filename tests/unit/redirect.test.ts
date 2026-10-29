import { describe, expect, it } from "vitest";
import { safeReturnPath } from "@/lib/redirect";

describe("safeReturnPath", () => {
  it("keeps same-site paths", () => {
    expect(safeReturnPath("/invite/abc")).toBe("/invite/abc");
    expect(safeReturnPath("/dashboard?period=fy")).toBe("/dashboard?period=fy");
  });
  it("reduces this app's absolute URLs to the path", () => {
    expect(safeReturnPath("https://lekha.vjas.in/invite/abc?x=1", "https://lekha.vjas.in")).toBe("/invite/abc?x=1");
  });
  it("rejects other sites and tricks", () => {
    for (const v of ["https://evil.example/invite/abc", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", undefined, 42]) {
      expect(safeReturnPath(v, "https://lekha.vjas.in")).toBeNull();
    }
  });
});
