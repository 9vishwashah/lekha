import { describe, expect, it } from "vitest";
import { applyFrom, as, createDb, rpc } from "./harness";

const AAGAM = "user_aagam";
const j = (v: unknown) => JSON.stringify(v);
type Db = Awaited<ReturnType<typeof createDb>>;

async function sharedAccount(db: Db, ownerName: string) {
  const ws = await rpc<string>(db, AAGAM, "public.create_workspace($1, $2, $3)", ["Aagam’s Personal", "Aagam Jain", null]);
  const client = await as(db, AAGAM, async (q) =>
    (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Vishwa', 'personal', $2) returning id`, [ws, AAGAM]))[0].id,
  );
  const ledger = await rpc<string>(db, AAGAM, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Asterisk", ledger_type: "personal", owner_name: ownerName, participant_client_ids: [client] })]);
  const names = () => as(db, AAGAM, (q) => q<{ display_name: string }>("select display_name from public.ledger_participants where ledger_id = $1 order by position", [ledger]));
  return { names };
}

describe("shared account owner names", () => {
  it("stores the owner's real name, never the word You", async () => {
    const db = await createDb();
    await rpc(db, AAGAM, "public.save_my_profile($1, $2)", ["Aagam Jain", "7738010929"]);
    const { names } = await sharedAccount(db, "You");
    expect((await names()).map((p) => p.display_name)).toEqual(["Aagam Jain", "Vishwa"]);
  });

  it("repairs accounts already saved with You", async () => {
    const db = await createDb({ until: "20261030001300" });
    await rpc(db, AAGAM, "public.save_my_profile($1, $2)", ["Aagam Jain", "7738010929"]);
    const { names } = await sharedAccount(db, "You");
    expect((await names())[0].display_name).toBe("You");
    await applyFrom(db, "20261030001300");
    expect((await names())[0].display_name).toBe("Aagam Jain");
  });
});
