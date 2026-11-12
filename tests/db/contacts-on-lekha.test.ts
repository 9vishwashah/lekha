import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";

const ME = "user_contacts_me";
const DHIRAJ = "user_contacts_dhiraj";
const TEAM = "user_contacts_team";
let db: Db;
let ws: string;

const client = async (name: string, phone: string | null) =>
  (await as(db, ME, (q) => q<{ id: string }>(`insert into public.contractors (workspace_id, name, phone, kind, created_by) values ($1, $2, $3, 'personal', $4) returning id`, [ws, name, phone, ME])))[0].id;
const matches = (who = ME) => rpc<{ contractor_id: string; username: string; full_name: string }[]>(db, who, "public.client_lekha_matches($1)", [ws]);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, ME, "public.create_workspace($1, $2, $3)", ["Mine", "Vishwa", null]);
  await rpc(db, DHIRAJ, "public.save_my_profile($1, $2)", ["Dhiraj Saini", "+919876543210"]);
  await rpc(db, DHIRAJ, "public.set_my_username($1)", ["dhirajsaini"]);
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role, display_name) values ($1, $2, 'member', 'Team')`, [ws, TEAM]);
});

describe("finding clients on Lekha by phone", () => {
  it("suggests a client whose number belongs to someone on Lekha, however the number was typed", async () => {
    const id = await client("Dhiraj", "098765 43210");
    expect(await matches()).toEqual([expect.objectContaining({ contractor_id: id, username: "dhirajsaini", full_name: "Dhiraj Saini" })]);
  });

  it("never links by itself; once linked by username the suggestion goes away", async () => {
    const [m] = await matches();
    const linked = (await as(db, ME, (q) => q<{ linked_user_id: string | null }>("select linked_user_id from public.contractors where id = $1", [m.contractor_id])))[0];
    expect(linked.linked_user_id).toBeNull();
    await rpc(db, ME, "public.link_client_by_username($1, $2)", [m.contractor_id, m.username]);
    expect(await matches()).toEqual([]);
  });

  it("does not suggest clients without a matching number, or yourself", async () => {
    await rpc(db, ME, "public.save_my_profile($1, $2)", ["Vishwa", "9594503214"]);
    await rpc(db, ME, "public.set_my_username($1)", ["vishwa"]);
    await client("Nobody", "9000000000");
    await client("Me again", "9594503214");
    expect(await matches()).toEqual([]);
  });

  it("only people who can edit the workspace may ask", async () => {
    await expect(matches(DHIRAJ)).rejects.toThrow();
  });

  it("says which picked contacts are on Lekha, yes or no only", async () => {
    const on = await rpc<string[]>(db, ME, "public.phones_on_lekha($1::text[])", [["+91 98765-43210", "9000000000", "12"]]);
    expect(on).toEqual(["9876543210"]);
    await expect(rpc(db, ME, "public.phones_on_lekha($1::text[])", [Array.from({ length: 101 }, (_, i) => String(9000000000 + i))])).rejects.toThrow(/100/);
  });
});
