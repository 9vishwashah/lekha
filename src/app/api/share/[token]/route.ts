import { NextResponse } from "next/server";
import { loadShared, sharedPersonalRecords, sharedVersion } from "@/lib/server/shared";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { ledgerStatementTable, personalLedgerTable } from "@/lib/reports";
import { exportResponse, parseFormat } from "@/lib/export/respond";
import type { Perspective } from "@/lib/domain/ledger";

export const runtime = "nodejs";

/**
 * Public, read-only endpoint for a share link.
 *   ?version=1          cheap "has anything changed" check used for live updates
 *   ?format=pdf|csv|xlsx  statement download with only the fields the owner allowed
 * There is no write method on this route.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/share/[token]">) {
  const { token } = await ctx.params;
  const url = new URL(request.url);
  const isVersion = url.searchParams.has("version");
  if (!allow(await clientKey(isVersion ? "share-poll" : "share-export"), isVersion ? 240 : 20, 60_000)) {
    return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
  }
  const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

  if (isVersion) {
    const version = await sharedVersion(token);
    if (!version) return NextResponse.json({ active: false }, { status: 404, headers: noStore });
    return NextResponse.json({ active: true, version }, { headers: noStore });
  }

  const format = parseFormat(url.searchParams.get("format"));
  if (!format) return NextResponse.json({ error: "Choose pdf, csv or xlsx" }, { status: 400 });
  const shared = await loadShared(token);
  if (!shared) return NextResponse.json({ error: "This link is no longer active" }, { status: 404, headers: noStore });

  if (shared.ledger.ledger_type === "personal") {
    const records = sharedPersonalRecords(shared);
    return exportResponse([personalLedgerTable({ name: shared.ledger.name, ...records })], format, {
      business: shared.ledger.name,
      fileName: `${shared.ledger.name} statement`,
    });
  }
  const table = ledgerStatementTable({
    ledger: {
      name: shared.ledger.name,
      ledger_type: shared.ledger.ledger_type,
      perspective: shared.ledger.perspective as Perspective,
      opening_balance: shared.ledger.opening_balance ?? "0",
    },
    partyName: shared.ledger.contractor_name,
    txns: shared.transactions,
    range: {},
    includeTax: shared.options.show_tax && shared.ledger.ledger_type === "taxation",
    includeBalance: shared.options.show_balance,
    includeRunning: shared.options.show_running_balance,
    includeReference: shared.options.show_reference,
    includeCounterparty: shared.options.show_counterparty,
  });
  return exportResponse([table], format, { business: shared.ledger.name, fileName: `${shared.ledger.name} statement` });
}
