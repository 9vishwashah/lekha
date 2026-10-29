import { describe, expect, it } from "vitest";
import { as, createDb, rpc } from "./harness";

const ME = "user_me";
const OTHER = "user_other";
const j = (v: unknown) => JSON.stringify(v);

describe("personal profile", () => {
  it("saves name and mobile privately and shows the name where others see it", async () => {
    const db = await createDb();
    const ws = await rpc<string>(db, ME, "public.create_workspace($1, $2, $3)", ["Home", "9vishwashah", null]);
    const client = await as(db, ME, async (q) =>
      (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Suraj', 'personal', $2) returning id`, [ws, ME]))[0].id,
    );
    const ledger = await rpc<string>(db, ME, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Trip", ledger_type: "personal", owner_name: "9vishwashah", participant_client_ids: [client] })]);

    await expect(rpc(db, ME, "public.save_my_profile($1, $2)", ["  ", "9876543210"])).rejects.toThrow(/Enter your name/);
    await expect(rpc(db, ME, "public.save_my_profile($1, $2)", ["Vishwa Shah", "12ab"])).rejects.toThrow(/mobile/);
    await rpc(db, ME, "public.save_my_profile($1, $2)", ["Vishwa Shah", "+91 98765-43210"]);

    const [mine] = await as(db, ME, (q) => q<{ full_name: string; phone: string }>("select full_name, phone from public.user_profiles"));
    expect(mine).toEqual({ full_name: "Vishwa Shah", phone: "+919876543210" });
    const [member] = await as(db, ME, (q) => q<{ display_name: string }>("select display_name from public.workspace_members where user_id = $1", [ME]));
    expect(member.display_name).toBe("Vishwa Shah");
    const [owner] = await as(db, ME, (q) => q<{ display_name: string }>("select display_name from public.ledger_participants where ledger_id = $1 and position = 0", [ledger]));
    expect(owner.display_name).toBe("Vishwa Shah");

    // Nobody else can read the profile or the mobile number.
    expect(await as(db, OTHER, (q) => q("select * from public.user_profiles"))).toEqual([]);
    await expect(as(db, OTHER, (q) => q("update public.user_profiles set phone = null"))).rejects.toThrow(/permission denied/);
    await expect(as(db, null, (q) => q("select * from public.user_profiles"))).rejects.toThrow(/permission denied/);
  });
});
