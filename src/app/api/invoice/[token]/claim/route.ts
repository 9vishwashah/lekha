import { NextResponse } from "next/server";
import { z } from "zod";
import { anonDb } from "@/lib/supabase/server";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { isTokenShape } from "@/lib/server/shared";
import { friendly } from "@/lib/server/errors";
import { MAX_UPLOAD_BYTES, sniffMime } from "@/lib/invoices/files";

export const runtime = "nodejs";

const schema = z.object({
  amount: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter the amount you paid"),
  paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date"),
  mode: z.enum(["cash", "upi", "bank_transfer", "cheque", "card", "other"]).or(z.literal("")),
  reference: z.string().trim().max(80),
  message: z.string().trim().max(500),
});

/** "I've made a payment". A note for the issuer to verify: this never changes any balance. */
export async function POST(request: Request, ctx: RouteContext<"/api/invoice/[token]/claim">) {
  const { token } = await ctx.params;
  if (!isTokenShape(token)) return NextResponse.json({ error: "This link is no longer active" }, { status: 404 });
  if (!allow(await clientKey("invoice-claim"), 5, 60_000)) return NextResponse.json({ error: "Please wait a minute and try again" }, { status: 429 });
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Please try again" }, { status: 400 });
  const parsed = schema.safeParse({
    amount: form.get("amount") ?? "",
    paid_on: form.get("paid_on") ?? "",
    mode: form.get("mode") ?? "",
    reference: form.get("reference") ?? "",
    message: form.get("message") ?? "",
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const file = form.get("proof");
  let bytes: Uint8Array | null = null;
  let mime: string | null = null;
  if (file instanceof File && file.size > 0) {
    bytes = new Uint8Array(await file.arrayBuffer());
    mime = sniffMime(bytes);
    if (bytes.length > MAX_UPLOAD_BYTES || !mime || !["image/png", "image/jpeg", "application/pdf"].includes(mime)) {
      return NextResponse.json({ error: "Attach a JPG, PNG or PDF under 4 MB" }, { status: 400 });
    }
  }
  const db = anonDb();
  const { data, error } = await db.rpc("submit_payment_claim", { p_token: token, p: { ...parsed.data, proof_mime: mime } });
  if (error) return NextResponse.json({ error: friendly(error) }, { status: 400 });
  const path = (data as { proof_path: string | null }).proof_path;
  if (bytes && path) {
    const up = await db.storage.from("invoice-files").upload(path, bytes, { contentType: mime!, upsert: false });
    if (!up.error) await db.rpc("confirm_claim_proof", { p_token: token, p_path: path });
  }
  return NextResponse.json({ ok: true });
}
