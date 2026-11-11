import { NextResponse } from "next/server";
import { z } from "zod";
import { anonDb } from "@/lib/supabase/server";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { isTokenShape } from "@/lib/server/shared";

export const runtime = "nodejs";

const schema = z.object({
  version: z.string().min(10).max(40),
  name: z.string().trim().max(80).optional(),
});

/**
 * "This statement is right", from the person the ledger was shared with. Records a confirmation
 * for the exact version they were looking at; it never changes any entry or balance.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/share/[token]/acknowledge">) {
  const { token } = await ctx.params;
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (!isTokenShape(token)) return NextResponse.json({ error: "This link is no longer active" }, { status: 404, headers });
  if (!allow(await clientKey("share-ack"), 10, 60_000)) return NextResponse.json({ error: "Please wait a minute and try again" }, { status: 429, headers });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Please refresh and try again" }, { status: 400, headers });

  const { data, error } = await anonDb().rpc("acknowledge_shared_ledger", {
    p_token: token,
    p_version: parsed.data.version,
    p_name: parsed.data.name || null,
  });
  if (error) {
    const changed = error.code === "40001";
    const gone = error.code === "P0002";
    return NextResponse.json(
      { error: changed ? "The statement changed since you opened it. The latest entries are now shown; check them, then confirm." : gone ? "This link is no longer active" : "That could not be saved. Try again.", changed },
      { status: changed ? 409 : gone ? 404 : 400, headers },
    );
  }
  return NextResponse.json({ ok: true, acknowledgement: data }, { headers });
}
