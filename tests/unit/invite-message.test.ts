import { describe, expect, it } from "vitest";
import { inviteMessage } from "@/lib/invite";

describe("Invite on Lekha message", () => {
  it("greets by first name, links to sign-up and signs with your @username", () => {
    const text = inviteMessage("Dhiraj Saini", { name: "Vishwa Shah", username: "9vishwashah" }, "https://lekha.vjas.in");
    expect(text.startsWith("Hi Dhiraj")).toBe(true);
    expect(text).toContain("https://lekha.vjas.in/sign-up");
    expect(text).toContain("@9vishwashah");
    expect(text.endsWith("– Vishwa Shah")).toBe(true);
    expect(text).not.toMatch(/\n\n\n/);
  });

  it("still reads well without a username or name", () => {
    const text = inviteMessage("", { name: null, username: null }, "https://x.test");
    expect(text).toContain("Hi there");
    expect(text).not.toContain("@");
  });
});
