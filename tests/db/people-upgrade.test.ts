import { describe, expect, it } from "vitest";
import { applyFrom, as, createDb, rpc } from "./harness";

const OWNER = "user_owner";
const j = (v: unknown) => JSON.stringify(v);

describe("upgrade: shared-account people become clients", () => {
  it("turns existing free-text participants into client records without touching balances", async () => {
    // A database as it was before the people migration, with a name typed into a shared account.
    const db = await createDb({ until: "20261029000800" });
    const ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Home", "Vishwa", null]);
    const existing = await as(db, OWNER, async (q) =>
      (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, created_by) values ($1, 'Rahul', $2) returning id`, [ws, OWNER]))[0].id,
    );
    const ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [
      j({ workspace_id: ws, name: "Goa trip", ledger_type: "personal", owner_name: "Vishwa", participants: ["Aagam Jain", "rahul"] }),
    ]);
    const people = await as(db, OWNER, (q) => q<{ id: string; position: number }>("select id, position from public.ledger_participants where ledger_id = $1 order by position", [ledger]));
    await rpc(db, OWNER, "public.create_shared_expense($1::jsonb)", [
      j({
        ledger_id: ledger, txn_date: "2026-10-20", description: "Villa", total_amount: "360", split_method: "equal",
        payers: [{ participant_id: people[0].id, amount: "360" }],
        shares: people.map((p) => ({ participant_id: p.id, amount: "120" })),
      }),
    ]);

    await applyFrom(db, "20261029000800");

    const after = await as(db, OWNER, (q) =>
      q<{ display_name: string; contractor_id: string | null; position: number }>(
        "select display_name, contractor_id, position from public.ledger_participants where ledger_id = $1 order by position",
        [ledger],
      ),
    );
    expect(after[0].contractor_id).toBeNull(); // the owner is "you", not a client
    expect(after.slice(1).every((p) => p.contractor_id)).toBe(true);
    expect(after[2].contractor_id).toBe(existing); // "rahul" matched the existing client "Rahul"
    const [aagam] = await as(db, OWNER, (q) => q<{ name: string; kind: string }>("select name, kind from public.contractors where id = $1", [after[1].contractor_id]));
    expect(aagam).toEqual({ name: "Aagam Jain", kind: "personal" });
    const nets = await db.query<{ n: string }>("select app.participant_net(id) as n from public.ledger_participants where ledger_id = $1 order by position", [ledger]);
    expect(nets.rows.map((r) => r.n)).toEqual(["240.00", "-120.00", "-120.00"]);

    // New participants can only be added as clients.
    const priya = await as(db, OWNER, async (q) =>
      (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Priya', 'personal', $2) returning id`, [ws, OWNER]))[0].id,
    );
    await rpc(db, OWNER, "public.add_ledger_participant($1, $2)", [ledger, priya]);
    await expect(rpc(db, OWNER, "public.add_ledger_participant($1, $2)", [ledger, priya])).rejects.toThrow(/already in this account/);
  });
});
