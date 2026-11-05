import { NextResponse } from "next/server";
import { anonDb } from "@/lib/supabase/server";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { isTokenShape } from "@/lib/server/shared";

/** Sent by the page itself, so WhatsApp's preview fetch never counts as the client viewing it. */
export async function POST(_: Request, ctx: RouteContext<"/api/invoice/[token]/viewed">) {
  const { token } = await ctx.params;
  if (isTokenShape(token) && allow(await clientKey("invoice-view"), 30, 60_000)) {
    await anonDb().rpc("note_invoice_view", { p_token: token });
  }
  return NextResponse.json({ ok: true });
}
