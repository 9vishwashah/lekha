import { renderCard } from "@/lib/og";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { loadInvoiceCard } from "@/lib/server/invoices";
import { documentTitle } from "@/lib/domain/invoice";
import { brandUrl } from "@/lib/invoices/doc";
import { formatINR, toPaise } from "@/lib/domain/money";

export const runtime = "nodejs";

/** Business logo as a data URI, or nothing: a missing logo must not break the preview. */
async function logoData(path: string | null) {
  const url = brandUrl(path);
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/png";
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The picture in a WhatsApp preview: who it is from, which invoice and its total, in the invoice's
 * card colour. Never the client's name. The ?v= in its address changes with the content.
 */
export async function GET(_: Request, ctx: RouteContext<"/invoice/[token]/card">) {
  const { token } = await ctx.params;
  const card = allow(await clientKey("invoice-card"), 30, 60_000) ? await loadInvoiceCard(token) : null;
  if (!card) {
    return renderCard({ kicker: "Lekha", title: "Link not active", headline: "Ask the sender for a new link", badge: "Invoice", color: "ink" });
  }
  const business = card.business ?? "Invoice";
  return renderCard({
    kicker: card.title ? `${business} · ${documentTitle(card.invoice_type)}` : documentTitle(card.invoice_type),
    title: card.title ?? business,
    headline: `Invoice No. ${card.invoice_no}`,
    amount: formatINR(toPaise(card.amount)),
    badge: "Secure invoice",
    color: "ink",
    hex: card.card_color,
    brandLogo: await logoData(card.logo_path),
  });
}
