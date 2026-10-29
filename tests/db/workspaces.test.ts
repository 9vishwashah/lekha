import { describe, expect, it, vi } from "vitest";
import { as, createDb, rpc } from "./harness";

const ME = "user_me";
const live: { db?: Awaited<ReturnType<typeof createDb>> } = {};
const cookieJar = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, updateTag: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (k: string, v: string) => cookieJar.set(k, v), get: (k: string) => (cookieJar.has(k) ? { value: cookieJar.get(k) } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
  notFound: () => {},
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), clerkClient: vi.fn(), currentUser: async () => ({ primaryEmailAddress: { emailAddress: "me@example.com" } }) }));
vi.mock("@/lib/server/context", () => ({
  MEMBERSHIPS_TAG: "memberships",
  WORKSPACE_COOKIE: "lekha_ws",
  requireUser: async () => ME,
  getMemberships: async () => [],
  getWorkspace: async () => ({}),
  getMyProfile: async () => (await as(live.db!, ME, (q) => q<{ full_name: string; phone: string }>("select full_name, phone from public.user_profiles")))[0] ?? null,
}));
vi.mock("@/lib/supabase/server", () => ({
  userDb: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      const sql = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      try {
        return { data: await rpc(live.db!, ME, sql, keys.map((k) => args[k])), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: "P0001" } };
      }
    },
  }),
  anonDb: () => ({}),
}));

const { createWorkspace } = await import("@/app/(app)/actions/workspace");
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};
const run = async (v: Record<string, string>) => {
  try {
    return { result: await createWorkspace(null, form(v)) };
  } catch (e) {
    return { redirect: (e as { to?: string }).to };
  }
};
const myWorkspaces = () => as(live.db!, ME, (q) => q<{ name: string; display_name: string }>("select w.name, m.display_name from public.workspace_members m join public.workspaces w on w.id = m.workspace_id order by m.created_at"));

describe("workspaces", () => {
  it("first setup, then another business from Settings with just a name", async () => {
    live.db = await createDb();
    expect(await run({ full_name: "Vishwa Shah", phone: "98765 43210", name: "VJAS" })).toEqual({ redirect: "/dashboard" });
    const first = cookieJar.get("lekha_ws");

    // "Another business?" sends only the workspace name.
    expect(await run({ name: "Shah Traders" })).toEqual({ redirect: "/dashboard" });
    expect(cookieJar.get("lekha_ws")).not.toBe(first); // switched to the new one
    expect(await myWorkspaces()).toEqual([
      { name: "VJAS", display_name: "Vishwa Shah" },
      { name: "Shah Traders", display_name: "Vishwa Shah" },
    ]);

    const empty = await run({ name: "  " });
    expect(empty.result).toMatchObject({ ok: false, fieldErrors: { name: "Give your workspace a name" } });
  });

  it("setup from an invitation may skip the workspace and returns to the invitation", async () => {
    live.db = await createDb();
    const next = `/invite/${"a".repeat(40)}`;
    expect(await run({ full_name: "Suraj", phone: "9123456780", name: "", next })).toEqual({ redirect: next });
    expect(await myWorkspaces()).toEqual([]);
    // Anything other than an invitation is ignored as a return path.
    expect(await run({ full_name: "Suraj", phone: "9123456780", name: "", next: "https://evil.example" })).toMatchObject({ result: { ok: false } });
  });
});
