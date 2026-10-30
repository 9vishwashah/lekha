import { describe, expect, it } from "vitest";
import { as, createDb, rpc } from "./harness";

const VISHWA = "user_vishwa";
const AAGAM = "user_aagam";
const NAMYA = "user_namya";
const j = (v: unknown) => JSON.stringify(v);
type Db = Awaited<ReturnType<typeof createDb>>;

async function person(db: Db, id: string, name: string, username: string) {
  await rpc(db, id, "public.save_my_profile($1, $2)", [name, "9876543210"]);
  return rpc<string>(db, id, "public.set_my_username($1)", [username]);
}

async function setup() {
  const db = await createDb();
  await person(db, VISHWA, "Vishwa Shah", "vishwa");
  await person(db, AAGAM, "Aagam Jain", "aagam");
  const ws = await rpc<string>(db, VISHWA, "public.create_workspace($1, $2, $3)", ["VJAS", "Vishwa Shah", null]);
  const client = (name: string) =>
    as(db, VISHWA, async (q) => (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, $2, 'personal', $3) returning id`, [ws, name, VISHWA]))[0].id);
  return { db, ws, client };
}

const access = (db: Db, who: string) =>
  as(db, who, (q) => q<{ ledger_id: string; status: string }>("select ledger_id, status from public.ledger_collaborators where user_id = $1", [who]));

describe("usernames", () => {
  it("are unique, tidy and validated", async () => {
    const { db } = await setup();
    expect(await rpc(db, NAMYA, "public.username_available($1)", ["@Aagam"])).toBe(false);
    expect(await rpc(db, NAMYA, "public.username_available($1)", ["namya.m"])).toBe(true);
    await expect(rpc(db, NAMYA, "public.set_my_username($1)", ["namya"])).rejects.toThrow(/Add your name first/);
    await rpc(db, NAMYA, "public.save_my_profile($1, $2)", ["Namya Mehta", "9324606405"]);
    await expect(rpc(db, NAMYA, "public.set_my_username($1)", ["AAGAM"])).rejects.toThrow(/taken/);
    await expect(rpc(db, NAMYA, "public.set_my_username($1)", ["ab"])).rejects.toThrow(/3–20/);
    await expect(rpc(db, NAMYA, "public.set_my_username($1)", ["admin"])).rejects.toThrow(/reserved/);
    expect(await rpc(db, NAMYA, "public.set_my_username($1)", [" @Namya.M "])).toBe("namya.m");
  });

  it("find exact usernames only, without phone numbers", async () => {
    const { db } = await setup();
    expect(await rpc(db, VISHWA, "public.find_by_username($1)", ["@AAGAM"])).toEqual({ username: "aagam", full_name: "Aagam Jain", avatar_path: null });
    expect(await rpc(db, VISHWA, "public.find_by_username($1)", ["aag"])).toBeNull();
    await expect(rpc(db, null, "public.find_by_username($1)", ["aagam"])).rejects.toThrow(/permission/);
    const people = await rpc<Record<string, unknown>[]>(db, VISHWA, "public.people_profiles($1)", [[AAGAM]]);
    expect(Object.keys(people[0]).sort()).toEqual(["avatar_path", "full_name", "user_id", "username"]);
  });

  it("photos live only in the person's own folder", async () => {
    const { db } = await setup();
    await expect(rpc(db, VISHWA, "public.set_my_avatar($1)", [`${AAGAM}/a.webp`])).rejects.toThrow(/Upload the photo again/);
    await expect(rpc(db, VISHWA, "public.set_my_avatar($1)", [`${VISHWA}/../${AAGAM}/a.webp`])).rejects.toThrow(/Upload the photo again/);
    await rpc(db, VISHWA, "public.set_my_avatar($1)", [`${VISHWA}/p1.webp`]);
    const [me] = await rpc<{ avatar_path: string }[]>(db, AAGAM, "public.people_profiles($1)", [[VISHWA]]);
    expect(me.avatar_path).toBe(`${VISHWA}/p1.webp`);
  });
});

describe("adding people by username", () => {
  it("adds someone to a shared account as themselves, reusing a client of the same name", async () => {
    const { db, ws, client } = await setup();
    const aagamClient = await client("Aagam Jain");
    const trip = await rpc<string>(db, VISHWA, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Goa", ledger_type: "personal", owner_name: "Vishwa", participant_client_ids: [aagamClient] })]);
    await rpc(db, VISHWA, "public.add_to_ledger_by_username($1, $2)", [trip, "@aagam"]);
    expect(await access(db, AAGAM)).toEqual([{ ledger_id: trip, status: "active" }]);
    // The existing "Aagam Jain" place is now him; no duplicate person was made.
    const places = await as(db, VISHWA, (q) => q<{ display_name: string; user_id: string | null }>("select display_name, user_id from public.ledger_participants where ledger_id = $1 order by position", [trip]));
    expect(places).toEqual([{ display_name: "Vishwa", user_id: VISHWA }, { display_name: "Aagam Jain", user_id: AAGAM }]);
    const [linked] = await as(db, VISHWA, (q) => q<{ linked_user_id: string }>("select linked_user_id from public.contractors where id = $1", [aagamClient]));
    expect(linked.linked_user_id).toBe(AAGAM);
    await expect(rpc(db, VISHWA, "public.add_to_ledger_by_username($1, $2)", [trip, "aagam"])).rejects.toThrow(/already in this account/);
    await expect(rpc(db, VISHWA, "public.add_to_ledger_by_username($1, $2)", [trip, "nobody"])).rejects.toThrow(/No one on Lekha has the username @nobody/);
    await expect(rpc(db, VISHWA, "public.add_to_ledger_by_username($1, $2)", [trip, "vishwa"])).rejects.toThrow(/That’s you/);
  });

  it("adds a new person to a shared account with a fresh client record", async () => {
    const { db, ws, client } = await setup();
    const suraj = await client("Suraj");
    const trip = await rpc<string>(db, VISHWA, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Dinner", ledger_type: "personal", owner_name: "Vishwa", participant_client_ids: [suraj] })]);
    await rpc(db, VISHWA, "public.add_to_ledger_by_username($1, $2)", [trip, "aagam"]);
    const [c] = await as(db, VISHWA, (q) => q<{ name: string; kind: string }>("select name, kind from public.contractors where linked_user_id = $1", [AAGAM]));
    expect(c).toEqual({ name: "Aagam Jain", kind: "personal" });
  });

  it("adds someone to a business ledger with the chosen permissions, and to a workspace", async () => {
    const { db, ws } = await setup();
    const book = await rpc<string>(db, VISHWA, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Site", ledger_type: "basic" })]);
    await rpc(db, VISHWA, "public.add_to_ledger_by_username($1, $2, $3::jsonb)", [book, "aagam", j({ can_create: true })]);
    const [row] = await as(db, AAGAM, (q) => q<{ can_create: boolean; can_edit_all: boolean }>("select can_create, can_edit_all from public.ledger_collaborators where ledger_id = $1", [book]));
    expect(row).toEqual({ can_create: true, can_edit_all: false });

    await person(db, NAMYA, "Namya Mehta", "namya");
    await rpc(db, VISHWA, "public.add_member_by_username($1, $2, $3)", [ws, "namya", "member"]);
    const [m] = await as(db, NAMYA, (q) => q<{ role: string; display_name: string }>("select role, display_name from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, NAMYA]));
    expect(m).toEqual({ role: "member", display_name: "Namya Mehta" });
    await expect(rpc(db, VISHWA, "public.add_to_ledger_by_username($1, $2)", [book, "namya"])).rejects.toThrow(/member of the workspace/);
    // Only admins add members; outsiders can't add anyone.
    await expect(rpc(db, NAMYA, "public.add_member_by_username($1, $2, $3)", [ws, "aagam", "viewer"])).rejects.toThrow();
    await expect(rpc(db, AAGAM, "public.add_to_ledger_by_username($1, $2)", [book, "namya"])).rejects.toThrow();
  });

  it("links a client record to an account and opens their shared accounts", async () => {
    const { db, ws, client } = await setup();
    const c = await client("AJ");
    const trip = await rpc<string>(db, VISHWA, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Goa", ledger_type: "personal", owner_name: "Vishwa", participant_client_ids: [c] })]);
    await rpc(db, VISHWA, "public.link_client_by_username($1, $2)", [c, "aagam"]);
    expect(await access(db, AAGAM)).toEqual([{ ledger_id: trip, status: "active" }]);
    const other = await client("Aagam again");
    await expect(rpc(db, VISHWA, "public.link_client_by_username($1, $2)", [other, "aagam"])).rejects.toThrow(/already linked to your client “AJ”/);
    await rpc(db, VISHWA, "public.disconnect_client($1)", [c]);
    expect(await access(db, AAGAM)).toEqual([{ ledger_id: trip, status: "revoked" }]);
  });
});

describe("invite links for people not on Lekha", () => {
  it("show the ledger read-only, then add the person as themselves when they join", async () => {
    const { db, ws, client } = await setup();
    const suraj = await client("Suraj");
    const trip = await rpc<string>(db, VISHWA, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Goa", ledger_type: "personal", owner_name: "Vishwa", participant_client_ids: [suraj] })]);
    const token = "t".repeat(40);
    await rpc(db, VISHWA, "public.create_invitation($1, $2::jsonb)", [token, j({ scope: "ledger", ledger_id: trip, can_create: true, can_edit_own: true })]);

    const view = await rpc<{ ledger: { name: string }; participants: { name: string }[] }>(db, null, "public.get_invitation_ledger($1)", [token]);
    expect(view.ledger.name).toBe("Goa");
    expect(view.participants.map((p) => p.name)).toEqual(["Vishwa", "Suraj"]);
    expect(JSON.stringify(view)).not.toContain(ws);
    const preview = await rpc<{ invited_by: string }>(db, null, "public.get_invitation_preview($1)", [token]);
    expect(preview.invited_by).toBe("Vishwa Shah");

    await person(db, NAMYA, "Namya Mehta", "namya");
    await rpc(db, NAMYA, "public.accept_invitation($1, $2, $3)", [token, "ignored", null]);
    const places = await as(db, VISHWA, (q) => q<{ display_name: string; user_id: string | null }>("select display_name, user_id from public.ledger_participants where ledger_id = $1 order by position", [trip]));
    expect(places.at(-1)).toEqual({ display_name: "Namya Mehta", user_id: NAMYA });
    expect(await access(db, NAMYA)).toEqual([{ ledger_id: trip, status: "active" }]);
    // Used links stop showing the ledger.
    expect(await rpc(db, null, "public.get_invitation_ledger($1)", [token])).toBeNull();
  });
});

describe("merging linked clients", () => {
  it("keeps the account link on the kept record", async () => {
    const { db, client } = await setup();
    const a = await client("Aagam Jain");
    const b = await client("Aagam J");
    await rpc(db, VISHWA, "public.link_client_by_username($1, $2)", [a, "aagam"]);
    await rpc(db, VISHWA, "public.merge_contractors($1, $2)", [a, b]);
    const rows = await as(db, VISHWA, (q) => q<{ id: string; linked_user_id: string | null }>("select id, linked_user_id from public.contractors where id in ($1, $2) order by name", [a, b]));
    expect(rows).toEqual([{ id: b, linked_user_id: AAGAM }, { id: a, linked_user_id: null }]);
  });
});
