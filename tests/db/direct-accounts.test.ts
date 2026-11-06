import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";

const OWNER = "user_owner";
const MEMBER = "user_member";
const NAMYA_USER = "user_namya";
const OUTSIDER = "user_outsider";
const j = (v: unknown) => JSON.stringify(v);

let db: Db;
let ws: string;
let category: string;
let namya: string;
let aagam: string;
let bank: string;

const client = (name: string) =>
  as(db, OWNER, async (q) =>
    (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, $2, 'personal', $3) returning id`, [ws, name, OWNER]))[0].id,
  );
const split = (p: Record<string, unknown>, who = OWNER) =>
  rpc<{ id: string; duplicate: boolean; expense_id: string | null; transaction_id: string | null }>(db, who, "public.create_split_expense($1::jsonb)", [
    j({ workspace_id: ws, title: "Dinner", expense_date: "2026-11-01", category_id: category, ...p }),
  ]);
const pay = (p: Record<string, unknown>) =>
  rpc<{ id: string; ledger_id: string; duplicate: boolean }>(db, OWNER, "public.record_client_payment($1::jsonb)", [
    j({ workspace_id: ws, txn_date: "2026-11-02", ...p }),
  ]);
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await as(db, OWNER, (q) => q<T>(sql, params)))[0];

const direct = async (id: string) => (await one<{ id: string }>("select id from public.ledgers where contractor_id = $1 and is_direct", [id]))?.id;
/** What a client owes the owner on their direct account: their negative net. */
const owes = async (id: string) => {
  const ledger = await direct(id);
  if (!ledger) return 0;
  const r = await db.query<{ net: string }>(
    "select app.participant_net(id) as net from public.ledger_participants where ledger_id = $1 and position = 0",
    [ledger],
  );
  return Number(r.rows[0].net);
};
const cash = async (ledger: string) =>
  Number((await one<{ v: string }>("select coalesce(sum(case direction when 'in' then amount else -amount end), 0) as v from public.transactions where ledger_id = $1 and status = 'posted'", [ledger])).v);
const spent = async (title: string) =>
  Number((await one<{ v: string }>("select coalesce(sum(amount), 0) as v from public.expenses where workspace_id = $1 and title = $2 and status = 'active'", [ws, title])).v);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["My Books", "Owner", null]);
  category = (await one<{ id: string }>("select id from public.expense_categories where workspace_id = $1 limit 1", [ws])).id;
  namya = await client("Namya Mehta");
  aagam = await client("Aagam Jain");
  bank = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "HDFC", ledger_type: "basic", perspective: "cashbook", opening_balance: "0" })]);
});

describe("direct client accounts", () => {
  it("one client: creates the account on first use and shows the full record", async () => {
    await split({ title: "Cab", amount: "900", your_share: "300", people: [{ contractor_id: namya, amount: "600" }] });
    expect(await owes(namya)).toBe(600);
    const rows = await as(db, OWNER, (q) => q<{ total_amount: string; split_group_id: string }>("select total_amount, split_group_id from public.shared_expenses where ledger_id = (select id from public.ledgers where contractor_id = $1 and is_direct)", [namya]));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_amount)).toBe(900);
  });

  it("reuses the same account every time, and never makes a second one", async () => {
    await split({ title: "Tea", amount: "100", your_share: "50", people: [{ contractor_id: namya, amount: "50" }] });
    const r = await one<{ n: string }>("select count(*) as n from public.ledgers where contractor_id = $1 and is_direct", [namya]);
    expect(Number(r.n)).toBe(1);
    expect(await owes(namya)).toBe(650);
  });

  it("a teammate adding an entry still books it on the business's side, not their own", async () => {
    const c = await client("Team Client");
    await db.query(`insert into public.workspace_members (workspace_id, user_id, role, display_name) values ($1, $2, 'member', 'Team')`, [ws, MEMBER]);
    await split({ title: "Lunch", amount: "200", your_share: "100", people: [{ contractor_id: c, amount: "100" }] }, MEMBER);
    const owner = await one<{ user_id: string }>("select user_id from public.ledger_participants where ledger_id = $1 and position = 0", [await direct(c)]);
    expect(owner.user_id).toBe(OWNER);
  });

  it("a client whose name matches the owner still works", async () => {
    const twin = await client("Owner");
    await split({ title: "Snacks", amount: "100", your_share: "50", people: [{ contractor_id: twin, amount: "50" }] });
    expect(await owes(twin)).toBe(50);
  });

  it("refuses an inactive client", async () => {
    const gone = await client("Gone Person");
    await db.query("update public.contractors set is_active = false where id = $1", [gone]);
    await expect(split({ title: "X", amount: "100", your_share: "50", people: [{ contractor_id: gone, amount: "50" }] })).rejects.toThrow(/inactive/);
  });

  it("no third person can join a direct account", async () => {
    await expect(rpc(db, OWNER, "public.add_ledger_participant($1, $2)", [await direct(namya), aagam])).rejects.toThrow(/between two people/);
  });

  it("cannot be archived, so its balance cannot disappear", async () => {
    await expect(rpc(db, OWNER, "public.set_ledger_status($1, 'archived')", [await direct(namya)])).rejects.toThrow(/cannot be archived/);
  });

  it("follows the client's new name", async () => {
    const c = await client("Old Name");
    await split({ title: "Y", amount: "100", your_share: "50", people: [{ contractor_id: c, amount: "50" }] });
    await db.query("update public.contractors set name = 'New Name' where id = $1", [c]);
    expect((await one<{ name: string }>("select name from public.ledgers where id = $1", [await direct(c)])).name).toBe("New Name");
  });

  it("a linked client can see their account", async () => {
    const c = await client("Linked Person");
    await db.query("update public.contractors set linked_user_id = $1 where id = $2", [NAMYA_USER, c]);
    await split({ title: "Z", amount: "100", your_share: "50", people: [{ contractor_id: c, amount: "50" }] });
    const seen = await as(db, NAMYA_USER, (q) => q("select id from public.ledgers where contractor_id = $1 and is_direct", [c]));
    expect(seen).toHaveLength(1);
    const stranger = await as(db, OUTSIDER, (q) => q("select id from public.ledgers where contractor_id = $1 and is_direct", [c]));
    expect(stranger).toHaveLength(0);
  });
});

describe("payments on a client", () => {
  it("received reduces what they owe, with no ledger needed", async () => {
    const c = await client("Pay One");
    await split({ title: "A", amount: "1000", your_share: "0", people: [{ contractor_id: c, amount: "1000" }] });
    await pay({ contractor_id: c, direction: "received", amount: "400" });
    expect(await owes(c)).toBe(600);
  });

  it("takes money ahead of any expense, and the balance simply flips", async () => {
    const c = await client("Pay Two");
    await pay({ contractor_id: c, direction: "received", amount: "500" });
    expect(await owes(c)).toBe(-500);
  });

  it("moves cash once when a cash ledger is chosen, and voiding undoes both", async () => {
    const c = await client("Pay Three");
    const before = await cash(bank);
    const p = await pay({ contractor_id: c, direction: "paid", amount: "250", ledger_id: bank });
    expect(await cash(bank)).toBe(before - 250);
    expect(await owes(c)).toBe(250);
    await rpc(db, OWNER, "public.void_settlement($1, $2)", [p.id, "Mistake"]);
    expect(await cash(bank)).toBe(before);
    expect(await owes(c)).toBe(0);
  });

  it("the cash entry cannot be changed on its own from the ledger", async () => {
    const c = await client("Pay Four");
    const p = await pay({ contractor_id: c, direction: "received", amount: "100", ledger_id: bank });
    const s = await one<{ transaction_id: string }>("select transaction_id from public.settlements where id = $1", [p.id]);
    await expect(rpc(db, OWNER, "public.void_transaction($1, $2)", [s.transaction_id, "x"])).rejects.toThrow(/client account/);
    await expect(rpc(db, OWNER, "public.reverse_transaction($1, $2, $3)", [s.transaction_id, "x", "2026-11-03"])).rejects.toThrow(/client account/);
  });

  it("refuses a party ledger, which would count it against them twice", async () => {
    const c = await client("Pay Five");
    const party = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Party", ledger_type: "basic", perspective: "party", contractor_id: c, opening_balance: "0" })]);
    await expect(pay({ contractor_id: c, direction: "received", amount: "100", ledger_id: party })).rejects.toThrow(/cash or bank/);
  });

  it("a repeated submit records one payment", async () => {
    const c = await client("Pay Six");
    const a = await pay({ contractor_id: c, direction: "received", amount: "100", idempotency_key: "pay-key-12345" });
    const b = await pay({ contractor_id: c, direction: "received", amount: "100", idempotency_key: "pay-key-12345" });
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
    expect(await owes(c)).toBe(-100);
  });

  it("an old balance is an ordinary entry that keeps both sides equal", async () => {
    const c = await client("Pay Seven");
    await rpc(db, OWNER, "public.record_client_opening($1::jsonb)", [j({ workspace_id: ws, contractor_id: c, amount: "1200", they_owe: true, txn_date: "2026-04-01" })]);
    expect(await owes(c)).toBe(1200);
    const c2 = await client("Pay Eight");
    await rpc(db, OWNER, "public.record_client_opening($1::jsonb)", [j({ workspace_id: ws, contractor_id: c2, amount: "300", they_owe: false, txn_date: "2026-04-01" })]);
    expect(await owes(c2)).toBe(-300);
  });
});

describe("splitting with several clients", () => {
  it("puts each share on each person, your share in expenses, and the cash once", async () => {
    const a = await client("Group A");
    const b = await client("Group B");
    const before = await cash(bank);
    const r = await split({ title: "Team dinner", amount: "1500", your_share: "500", ledger_id: bank, people: [{ contractor_id: a, amount: "500" }, { contractor_id: b, amount: "500" }] });
    expect(await owes(a)).toBe(500);
    expect(await owes(b)).toBe(500);
    expect(await spent("Team dinner")).toBe(500);
    expect(await cash(bank)).toBe(before - 1500);
    expect(r.duplicate).toBe(false);
  });

  it("rejects shares that do not add up to the total", async () => {
    const a = await client("Sum A");
    const b = await client("Sum B");
    await expect(split({ amount: "1000", your_share: "300", people: [{ contractor_id: a, amount: "300" }, { contractor_id: b, amount: "300" }] })).rejects.toThrow(/add up/);
    expect(await direct(a)).toBeUndefined(); // nothing half-saved
  });

  it("refuses someone else paying for a group: that debt is not yours to record", async () => {
    const a = await client("Payer A");
    const b = await client("Payer B");
    await expect(split({ amount: "900", your_share: "300", paid_by_contractor_id: a, people: [{ contractor_id: a, amount: "300" }, { contractor_id: b, amount: "300" }] })).rejects.toThrow(/shared account/);
  });

  it("one client paid: you owe them your share", async () => {
    const a = await client("They Paid");
    await split({ title: "Their treat", amount: "900", your_share: "300", paid_by_contractor_id: a, people: [{ contractor_id: a, amount: "600" }] });
    expect(await owes(a)).toBe(-300);
    expect(await spent("Their treat")).toBe(300);
  });

  it("no cash ledger when they paid", async () => {
    const a = await client("Ghost Cash");
    await expect(split({ amount: "900", your_share: "300", paid_by_contractor_id: a, ledger_id: bank, people: [{ contractor_id: a, amount: "600" }] })).rejects.toThrow(/no money left/);
  });

  it("refuses a split where nobody owes anybody", async () => {
    const a = await client("Nobody");
    await expect(split({ amount: "900", your_share: "900", people: [{ contractor_id: a, amount: "0" }] })).rejects.toThrow(/No one owes/);
  });

  it("the same person cannot be added twice", async () => {
    const a = await client("Twice");
    await expect(split({ amount: "900", your_share: "300", people: [{ contractor_id: a, amount: "300" }, { contractor_id: a, amount: "300" }] })).rejects.toThrow(/only once/);
  });

  it("a double submit saves once", async () => {
    const a = await client("Double A");
    const b = await client("Double B");
    const p = { title: "Double", amount: "300", your_share: "100", idempotency_key: "split-key-1234", people: [{ contractor_id: a, amount: "100" }, { contractor_id: b, amount: "100" }] };
    const first = await split(p);
    const again = await split(p);
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect(await owes(a)).toBe(100);
    expect(await spent("Double")).toBe(100);
  });

  it("is all or nothing when one person cannot be used", async () => {
    const a = await client("Atomic A");
    const b = await client("Atomic B");
    await db.query("update public.contractors set is_active = false where id = $1", [b]);
    const before = await cash(bank);
    await expect(split({ title: "Atomic", amount: "300", your_share: "100", ledger_id: bank, people: [{ contractor_id: a, amount: "100" }, { contractor_id: b, amount: "100" }] })).rejects.toThrow(/inactive/);
    expect(await direct(a)).toBeUndefined();
    expect(await spent("Atomic")).toBe(0);
    expect(await cash(bank)).toBe(before);
  });
});

describe("a split stays whole", () => {
  async function made(title: string) {
    const a = await client(`${title} A`);
    const b = await client(`${title} B`);
    const before = await cash(bank);
    const r = await split({ title, amount: "900", your_share: "300", ledger_id: bank, people: [{ contractor_id: a, amount: "300" }, { contractor_id: b, amount: "300" }] });
    const leg = await one<{ id: string }>("select id from public.shared_expenses where split_group_id = $1 limit 1", [r.id]);
    return { a, b, before, r, leg: leg.id };
  }
  const allGone = async (x: Awaited<ReturnType<typeof made>>, title: string) => {
    expect(await owes(x.a)).toBe(0);
    expect(await owes(x.b)).toBe(0);
    expect(await spent(title)).toBe(0);
    expect(await cash(bank)).toBe(x.before);
  };

  it("voiding the expense voids every share and the cash", async () => {
    const x = await made("Void via expense");
    await rpc(db, OWNER, "public.void_expense($1, $2)", [x.r.expense_id, "Wrong"]);
    await allGone(x, "Void via expense");
  });

  it("voiding one person's share voids the whole split", async () => {
    const x = await made("Void via share");
    await rpc(db, OWNER, "public.void_shared_expense($1, $2)", [x.leg, "Wrong"]);
    await allGone(x, "Void via share");
  });

  it("the cash entry cannot be voided or reversed alone", async () => {
    const x = await made("Cash alone");
    await expect(rpc(db, OWNER, "public.void_transaction($1, $2)", [x.r.transaction_id, "x"])).rejects.toThrow(/split expense/);
    expect(await owes(x.a)).toBe(300);
  });

  it("one share cannot be corrected on its own", async () => {
    const x = await made("Correct alone");
    await expect(rpc(db, OWNER, "public.correct_shared_expense($1, $2::jsonb)", [x.leg, j({})])).rejects.toThrow(/part of a split/);
  });

  it("the expense amount cannot drift from the shares", async () => {
    const x = await made("Amount drift");
    await expect(rpc(db, OWNER, "public.update_expense($1, $2::jsonb)", [x.r.expense_id, j({ amount: "1" })])).rejects.toThrow(/split with other people/);
    await rpc(db, OWNER, "public.update_expense($1, $2::jsonb)", [x.r.expense_id, j({ notes: "Fine to change" })]);
  });

  it("a client who can see one share cannot undo the others", async () => {
    const a = await client("Viewer A");
    const b = await client("Viewer B");
    await db.query("update public.contractors set linked_user_id = $1 where id = $2", ["user_viewer_a", a]);
    const r = await split({ title: "Viewer", amount: "900", your_share: "300", people: [{ contractor_id: a, amount: "300" }, { contractor_id: b, amount: "300" }] });
    const leg = await one<{ id: string }>("select id from public.shared_expenses where split_group_id = $1 and ledger_id = $2", [r.id, await direct(a)]);
    await expect(rpc(db, "user_viewer_a", "public.void_shared_expense($1, $2)", [leg.id, "Nope"])).rejects.toThrow();
    expect(await owes(b)).toBe(300);
  });

  it("is hidden from other workspaces", async () => {
    await rpc<string>(db, OUTSIDER, "public.create_workspace($1, $2, $3)", ["Other", "Other", null]);
    const seen = await as(db, OUTSIDER, (q) => q("select id from public.split_groups"));
    expect(seen).toHaveLength(0);
  });
});

describe("adopting an existing two-person account", () => {
  it("keeps its balance and makes it the client's account", async () => {
    const c = await client("Mota Bhai Friend");
    const l = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Mota Bhai", ledger_type: "personal", owner_name: "Owner", participant_client_ids: [c] })]);
    const ps = await as(db, OWNER, (q) => q<{ id: string }>("select id from public.ledger_participants where ledger_id = $1 order by position", [l]));
    await rpc(db, OWNER, "public.create_shared_expense($1::jsonb)", [j({ ledger_id: l, txn_date: "2026-10-01", description: "Old", total_amount: "2444", split_method: "exact", payers: [{ participant_id: ps[0].id, amount: "2444" }], shares: [{ participant_id: ps[1].id, amount: "2444" }] })]);
    await rpc(db, OWNER, "public.adopt_direct_ledger($1)", [l]);
    expect(await owes(c)).toBe(2444);
    await pay({ contractor_id: c, direction: "received", amount: "444" });
    expect(await owes(c)).toBe(2000);
    expect(await direct(c)).toBe(l);
    expect((await one<{ name: string }>("select name from public.ledgers where id = $1", [l])).name).toBe("Mota Bhai");
  });

  it("refuses a group, and a second account for the same client", async () => {
    const c = await client("Adopt One");
    const d = await client("Adopt Two");
    const group = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Trip", ledger_type: "personal", owner_name: "Owner", participant_client_ids: [c, d] })]);
    await expect(rpc(db, OWNER, "public.adopt_direct_ledger($1)", [group])).rejects.toThrow(/two people/);
    await pay({ contractor_id: c, direction: "received", amount: "1" });
    const other = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Second", ledger_type: "personal", owner_name: "Owner", participant_client_ids: [c] })]);
    await expect(rpc(db, OWNER, "public.adopt_direct_ledger($1)", [other])).rejects.toThrow(/already has/);
  });

  it("nothing is converted without being asked", async () => {
    const c = await client("Left Alone");
    const l = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Left", ledger_type: "personal", owner_name: "Owner", participant_client_ids: [c] })]);
    expect((await one<{ is_direct: boolean }>("select is_direct from public.ledgers where id = $1", [l])).is_direct).toBe(false);
  });
});

describe("merging clients", () => {
  it("keeps both balances when each has a direct account", async () => {
    const a = await client("Merge From");
    const b = await client("Merge Into");
    await pay({ contractor_id: a, direction: "paid", amount: "100" });
    await pay({ contractor_id: b, direction: "paid", amount: "50" });
    const fromLedger = await direct(a);
    await rpc(db, OWNER, "public.merge_contractors($1, $2)", [a, b]);
    expect(await owes(b)).toBe(50);
    const moved = await one<{ is_direct: boolean; contractor_id: string | null }>("select is_direct, contractor_id from public.ledgers where id = $1", [fromLedger]);
    expect(moved.is_direct).toBe(false);
    const p = (await db.query<{ contractor_id: string; net: string }>("select contractor_id, app.participant_net(id) as net from public.ledger_participants where ledger_id = $1 and position = 1", [fromLedger])).rows[0];
    expect(p.contractor_id).toBe(b);
    expect(Number(p.net)).toBe(-100);
  });

  it("carries the account over when only one has it", async () => {
    const a = await client("Solo From");
    const b = await client("Solo Into");
    await pay({ contractor_id: a, direction: "paid", amount: "70" });
    await rpc(db, OWNER, "public.merge_contractors($1, $2)", [a, b]);
    expect(await owes(b)).toBe(70);
  });
});

describe("repayments in a group", () => {
  it("A can pay B even when what A owes and is owed cancel out", async () => {
    const b = await client("Trip B");
    const c = await client("Trip C");
    const l = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Trip", ledger_type: "personal", owner_name: "Owner", participant_client_ids: [b, c] })]);
    const [me, pb, pc] = (await as(db, OWNER, (q) => q<{ id: string }>("select id from public.ledger_participants where ledger_id = $1 order by position", [l]))).map((p) => p.id);
    const expense = (payer: string, sharer: string) =>
      rpc(db, OWNER, "public.create_shared_expense($1::jsonb)", [j({ ledger_id: l, txn_date: "2026-10-01", description: "x", total_amount: "1000", split_method: "exact", payers: [{ participant_id: payer, amount: "1000" }], shares: [{ participant_id: sharer, amount: "1000" }] })]);
    await expense(pb, me); // you owe B
    await expense(me, pc); // C owes you
    const settle = (amount: string) =>
      rpc(db, OWNER, "public.record_settlement($1::jsonb)", [j({ ledger_id: l, from_participant_id: me, to_participant_id: pb, amount, txn_date: "2026-10-02" })]);
    await expect(settle("1001")).rejects.toThrow(/more than/);
    await settle("1000");
    const net = (await db.query<{ n: string }>("select app.participant_net($1) as n", [me])).rows[0];
    expect(Number(net.n)).toBe(1000); // now C owes you, and only you
  });

  it("still refuses a repayment between two people who are square", async () => {
    const b = await client("Square B");
    const l = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Square", ledger_type: "personal", owner_name: "Owner", participant_client_ids: [b] })]);
    const [me, pb] = (await as(db, OWNER, (q) => q<{ id: string }>("select id from public.ledger_participants where ledger_id = $1 order by position", [l]))).map((p) => p.id);
    await expect(rpc(db, OWNER, "public.record_settlement($1::jsonb)", [j({ ledger_id: l, from_participant_id: me, to_participant_id: pb, amount: "10", txn_date: "2026-10-02" })])).rejects.toThrow(/Nothing is outstanding/);
  });
});

describe("ledger perspective", () => {
  it("is locked once entries exist, free before", async () => {
    const l = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Flip", ledger_type: "basic", perspective: "cashbook", opening_balance: "0" })]);
    await rpc(db, OWNER, "public.update_ledger($1, $2::jsonb)", [l, j({ perspective: "party" })]);
    await rpc(db, OWNER, "public.update_ledger($1, $2::jsonb)", [l, j({ perspective: "cashbook" })]);
    await rpc(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: l, txn_date: "2026-11-01", direction: "in", amount: "100", kind: "regular", status: "posted" })]);
    await expect(rpc(db, OWNER, "public.update_ledger($1, $2::jsonb)", [l, j({ perspective: "party" })])).rejects.toThrow(/cannot change/);
    await rpc(db, OWNER, "public.update_ledger($1, $2::jsonb)", [l, j({ perspective: "cashbook", name: "Renamed" })]);
  });
});

describe("adjusting an advance against a bill in another ledger", () => {
  async function setup(name: string, advanceLedger: "none" | "cash" | "party") {
    const c = await client(name);
    const party = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: `${name} party`, ledger_type: "taxation", perspective: "party", contractor_id: c, opening_balance: "0" })]);
    const other = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: `${name} old`, ledger_type: "basic", perspective: "party", contractor_id: c, opening_balance: "0" })]);
    const adv = await rpc<{ id: string }>(db, OWNER, "public.create_advance($1::jsonb)", [j({ workspace_id: ws, contractor_id: c, amount: "1000", given_date: "2026-10-01", ledger_id: advanceLedger === "cash" ? bank : advanceLedger === "party" ? other : "" })]);
    const bill = await rpc<{ id: string }>(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: party, txn_date: "2026-10-05", direction: "in", amount: "5000", kind: "invoice", status: "posted", tax: { taxable_amount: "5000", gst_applicable: false, tds_applicable: false } })]);
    const closing = async (ledger: string) =>
      Number((await one<{ v: string }>("select coalesce(sum(case direction when 'out' then amount else -amount end) filter (where affects_party and status = 'posted'), 0) as v from public.transactions where ledger_id = $1", [ledger])).v);
    const adjust = (amount = "1000") => rpc<{ id: string; transaction_id: string | null }>(db, OWNER, "public.record_advance_allocation($1::jsonb)", [j({ advance_id: adv.id, kind: "adjustment", amount, alloc_date: "2026-10-06", bill_transaction_id: bill.id })]);
    return { party, other, closing, adjust };
  }

  it("reaches the bill's ledger when the advance came from a cash book", async () => {
    const s = await setup("Adv Cash", "cash");
    expect(await s.closing(s.party)).toBe(-5000);
    const a = await s.adjust();
    expect(await s.closing(s.party)).toBe(-4000);
    await rpc(db, OWNER, "public.void_advance_allocation($1, $2)", [a.id, "Undo"]);
    expect(await s.closing(s.party)).toBe(-5000);
  });

  it("reaches the bill's ledger when the advance had no ledger", async () => {
    const s = await setup("Adv None", "none");
    await s.adjust();
    expect(await s.closing(s.party)).toBe(-4000);
  });

  it("adds nothing when another party ledger already holds the advance", async () => {
    const s = await setup("Adv Party", "party");
    expect((await s.closing(s.party)) + (await s.closing(s.other))).toBe(-4000);
    const a = await s.adjust();
    expect(a.transaction_id).toBeNull();
    expect((await s.closing(s.party)) + (await s.closing(s.other))).toBe(-4000); // not counted twice
  });

  it("the adjustment entry cannot be voided from the ledger", async () => {
    const s = await setup("Adv Guard", "cash");
    const a = await s.adjust();
    await expect(rpc(db, OWNER, "public.void_transaction($1, $2)", [a.transaction_id, "x"])).rejects.toThrow(/advance/);
  });
});
