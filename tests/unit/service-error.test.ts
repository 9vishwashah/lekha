import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), clerkClient: vi.fn() }));

const { ServiceError } = await import("@/lib/server/context");

describe("first-request failures are named, not hidden", () => {
  it.each([
    [{ code: "PGRST301", message: "No suitable key or wrong key type" }, "trust"],
    [{ code: "PGRST303", message: "JWT expired" }, "expired"],
    [{ code: "42501", message: "permission denied for table workspace_members" }, "role"],
    [{ code: "42703", message: 'column contractors.kind does not exist' }, "schema"],
    [{ code: "PGRST205", message: "Could not find the table in the schema cache" }, "schema"],
    [{ code: "", message: "TypeError: fetch failed" }, "network"],
    [{ code: "XX000", message: "something else" }, "unknown"],
  ])("%j → %s", (error, kind) => {
    const e = new ServiceError(error);
    expect(e.kind).toBe(kind);
    expect(e.message).not.toMatch(/key|secret/i);
  });
});
