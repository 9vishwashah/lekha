import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { friendly } from "@/lib/server/errors";

export const runtime = "nodejs";

const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
const payload = z.object({
  ledger_id: z.string().uuid(),
  file_name: z.string().max(200),
  file_hash: z.string().regex(/^[0-9a-f]{64}$/),
  sheet_name: z.string().max(100),
  skipped_count: z.number().int().min(0),
  issues: z.array(z.object({ row: z.number().int(), status: z.string().max(20), messages: z.array(z.string().max(300)) })).max(10_000),
  rows: z
    .array(
      z.object({
        row: z.number().int().positive(),
        txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        direction: z.enum(["in", "out"]),
        amount: amount.nullable(),
        description: z.string().max(500).nullable(),
        counterparty: z.string().max(160).nullable(),
        reference_no: z.string().max(80).nullable(),
        tax: z.object({ taxable_amount: amount, gst_amount: amount, tds_amount: amount }).optional(),
      }),
    )
    .min(1)
    .max(5000),
});

/** Commits confirmed rows in one database transaction (all or nothing). */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to import" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = payload.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: `Some rows are not valid: ${parsed.error.issues[0].path.join(".")}` }, { status: 400 });
  }
  const db = await userDb();
  const { data, error } = await db.rpc("import_transactions", {
    p: { ...parsed.data, rows: parsed.data.rows.map((r) => ({ ...r, description: r.description?.slice(0, 500) ?? null })) },
  });
  if (error) return NextResponse.json({ error: friendly(error) }, { status: error.code === "42501" ? 403 : 400 });
  revalidatePath(`/ledgers/${parsed.data.ledger_id}`);
  revalidatePath("/ledgers");
  return NextResponse.json(data);
}
