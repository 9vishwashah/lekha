import { OG_SIZE, renderCard } from "@/lib/og";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { loadInvoiceCard } from "@/lib/server/invoices";
import { documentTitle } from "@/lib/domain/invoice";
import { brandUrl } from "@/lib/invoices/doc";

export const alt = "Invoice";
export const size = OG_SIZE;
export const contentType = "image/png";

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

/** WhatsApp preview: who it is from and which invoice. Never the amount or the client. */
export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const card = allow(await clientKey("invoice-card"), 30, 60_000) ? await loadInvoiceCard(token) : null;
  if (!card) {
    return renderCard({ kicker: "Lekha", title: "Link not active", headline: "Ask the sender for a new link", badge: "Invoice", color: "ink" });
  }
  return renderCard({
    kicker: documentTitle(card.invoice_type),
    title: card.business ?? "Invoice",
    headline: `No. ${card.invoice_no}`,
    chips: ["View", "Download"],
    badge: "Secure invoice",
    color: "ink",
    hex: card.brand_color,
    brandLogo: await logoData(card.logo_path),
  });
}
