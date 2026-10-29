import { describe, expect, it } from "vitest";
import { as, createDb, rpc } from "./harness";

const VISHWA = { id: "user_vishwa", email: "9vishwashah@gmail.com" };
const AAGAM = { id: "user_aagam", email: "aagam@example.com" };
const STRANGER = { id: "user_stranger", email: "someone@example.com" };
const j = (v: unknown) => JSON.stringify(v);

async function setup() {
  const db = await createDb();
  const ws = await rpc<string>(db, VISHWA, "public.create_workspace($1, $2, $3)", ["VJAS", "Vishwa Shah", null]);
  const client = await as(db, VISHWA, async (q) =>
    (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Aagam Jain', 'personal', $2) returning id`, [ws, VISHWA.id]))[0].id,
  );
  const trip = await rpc<string>(db, VISHWA, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Goa trip", ledger_type: "personal", owner_name: "Vishwa", participant_client_ids: [client] })]);
  const inbox = (who: typeof AAGAM) => rpc<{ id: string; from_name: string; business: string; as_name: string }[]>(db, who, "public.my_connection_requests()");
  const linked = async () => (await as(db, VISHWA, (q) => q<{ linked_user_id: string | null }>("select linked_user_id from public.contractors where id = $1", [client])))[0].linked_user_id;
  return { db, ws, client, trip, inbox, linked };
}

describe("connect requests", () => {
  it("links a client to their own account only when they accept, and opens their shared accounts", async () => {
    const { db, client, trip, inbox, linked } = await setup();
    await expect(rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, ""])).rejects.toThrow(/Add Aagam Jain’s email/);
    await rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, "  Aagam@Example.com "]);

    // Stored on the client too, and nothing is linked yet.
    const [c] = await as(db, VISHWA, (q) => q<{ email: string }>("select email from public.contractors where id = $1", [client]));
    expect(c.email).toBe("aagam@example.com");
    expect(await linked()).toBeNull();

    // Only the owner of that verified email sees the request, and only who is asking.
    expect(await inbox(STRANGER)).toEqual([]);
    const [req] = await inbox(AAGAM);
    expect(req).toMatchObject({ from_name: "Vishwa Shah", business: "VJAS", as_name: "Aagam Jain" });
    expect(Object.keys(req).sort()).toEqual(["as_name", "business", "created_at", "from_name", "id"]);
    await expect(rpc(db, STRANGER, "public.respond_client_connection($1, true)", [req.id])).rejects.toThrow(/no longer open/);
    // A token without an email claim can never answer.
    await expect(rpc(db, AAGAM.id, "public.respond_client_connection($1, true)", [req.id])).rejects.toThrow(/no longer open/);

    // Aagam cannot read the sender's records directly.
    expect(await as(db, AAGAM, (q) => q("select * from public.client_connections"))).toEqual([]);
    expect(await as(db, AAGAM, (q) => q("select id, name, email from public.contractors"))).toEqual([]);

    const res = await rpc<{ accepted: boolean; shared_accounts: number }>(db, AAGAM, "public.respond_client_connection($1, true)", [req.id]);
    expect(res).toEqual({ accepted: true, shared_accounts: 1 });
    expect(await linked()).toBe(AAGAM.id);
    expect(await inbox(AAGAM)).toEqual([]);
    // The shared account now appears for him, as himself.
    const shared = await as(db, AAGAM, (q) => q<{ ledger_id: string; status: string }>("select ledger_id, status from public.ledger_collaborators where user_id = $1", [AAGAM.id]));
    expect(shared).toEqual([{ ledger_id: trip, status: "active" }]);
    await expect(rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, AAGAM.email])).rejects.toThrow(/already connected/);
  });

  it("adds a connected client to new shared accounts straight away", async () => {
    const { db, ws, client, inbox } = await setup();
    await rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, AAGAM.email]);
    const [req] = await inbox(AAGAM);
    await rpc(db, AAGAM, "public.respond_client_connection($1, true)", [req.id]);
    const dinner = await rpc<string>(db, VISHWA, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Dinner club", ledger_type: "personal", owner_name: "Vishwa", participant_client_ids: [client] })]);
    const rows = await as(db, AAGAM, (q) => q<{ ledger_id: string }>("select ledger_id from public.ledger_collaborators where user_id = $1 and ledger_id = $2", [AAGAM.id, dinner]));
    expect(rows).toHaveLength(1);
  });

  it("declining, cancelling and disconnecting", async () => {
    const { db, client, trip, inbox, linked } = await setup();
    await rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, AAGAM.email]);
    let [req] = await inbox(AAGAM);
    await rpc(db, AAGAM, "public.respond_client_connection($1, false)", [req.id]);
    expect(await linked()).toBeNull();
    expect(await inbox(AAGAM)).toEqual([]);

    // A new request replaces any open one; cancelling withdraws it.
    await rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, AAGAM.email]);
    await rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, AAGAM.email]);
    expect(await inbox(AAGAM)).toHaveLength(1);
    await rpc(db, VISHWA, "public.cancel_client_connection($1)", [client]);
    expect(await inbox(AAGAM)).toEqual([]);

    await rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, AAGAM.email]);
    [req] = await inbox(AAGAM);
    await rpc(db, AAGAM, "public.respond_client_connection($1, true)", [req.id]);
    await rpc(db, VISHWA, "public.disconnect_client($1)", [client]);
    expect(await linked()).toBeNull();
    const access = await as(db, AAGAM, (q) => q<{ status: string }>("select status from public.ledger_collaborators where ledger_id = $1 and user_id = $2", [trip, AAGAM.id]));
    expect(access).toEqual([{ status: "revoked" }]);
  });

  it("refuses requests from outsiders and to yourself", async () => {
    const { db, client } = await setup();
    await expect(rpc(db, STRANGER, "public.request_client_connection($1, $2)", [client, AAGAM.email])).rejects.toThrow(/permission|not allowed|access/i);
    await expect(rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, VISHWA.email.toUpperCase()])).rejects.toThrow(/your own email/);
    await expect(rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, "not-an-email"])).rejects.toThrow(/valid email/);
  });
});

describe("merging connected clients", () => {
  it("keeps the account link and moves shared-account places to the kept record", async () => {
    const { db, ws, client, trip, inbox } = await setup();
    await rpc(db, VISHWA, "public.request_client_connection($1, $2)", [client, AAGAM.email]);
    const [req] = await inbox(AAGAM);
    await rpc(db, AAGAM, "public.respond_client_connection($1, true)", [req.id]);
    const dup = await as(db, VISHWA, async (q) =>
      (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Aagam J', 'business', $2) returning id`, [ws, VISHWA.id]))[0].id,
    );
    await rpc(db, VISHWA, "public.merge_contractors($1, $2)", [client, dup]);
    const rows = await as(db, VISHWA, (q) => q<{ id: string; linked_user_id: string | null }>("select id, linked_user_id from public.contractors where id in ($1, $2) order by name", [client, dup]));
    expect(rows).toEqual([{ id: dup, linked_user_id: AAGAM.id }, { id: client, linked_user_id: null }]);
    const [place] = await as(db, VISHWA, (q) => q<{ contractor_id: string }>("select contractor_id from public.ledger_participants where ledger_id = $1 and position = 1", [trip]));
    expect(place.contractor_id).toBe(dup);
  });
});
