import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, as } from "./harness";
import { buildStatement } from "@/lib/domain/ledger";
import { toDecimal } from "@/lib/domain/money";

describe("development seed", () => {
  it("runs through the app's own functions and produces consistent balances", async () => {
    const db = await createDb();
    await db.exec(readFileSync(path.resolve(process.cwd(), "supabase/seed.sql"), "utf8"));
    const rows = await as(db, "user_seed_owner", (q) =>
      q<{ seq: number; txn_date: string; direction: "in" | "out"; amount: string; kind: "regular"; is_cash: boolean; affects_party: boolean; status: "posted"; opening_balance: string }>(
        `select t.seq, t.txn_date::text, t.direction, t.amount::text, t.kind, t.is_cash, t.affects_party, t.status, l.opening_balance::text
         from public.transactions t join public.ledgers l on l.id = t.ledger_id where l.ledger_type = 'basic'`,
      ),
    );
    const s = buildStatement({ perspective: "cashbook", opening_balance: rows[0].opening_balance }, rows);
    // 25,000 + 50,000 − 8,400 − 12,500 − 20,000 advance
    expect(toDecimal(s.closing)).toBe("34100.00");
    const [net] = await db.query<{ n: string }>(
      "select app.participant_net(id) as n from public.ledger_participants where position = 1",
    ).then((r) => r.rows);
    expect(net.n).toBe("-400.00");
    const audit = await db.query<{ c: number }>("select count(*)::int as c from public.audit_logs");
    expect(audit.rows[0].c).toBeGreaterThan(10);
  });
});
