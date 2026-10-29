import { OG_SIZE, renderCard } from "@/lib/og";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { loadShareCard, loadSharedOnce, summarizeShare } from "@/lib/server/share-card";

export const alt = "Ledger statement on Lekha";
export const size = OG_SIZE;
export const contentType = "image/png";

/** The WhatsApp preview for one shared ledger: its colour, name, balance and who sent it. */
export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ok = allow(await clientKey("share-card"), 30, 60_000);
  const [shared, card] = ok ? await Promise.all([loadSharedOnce(token), loadShareCard(token)]) : [null, null];
  if (!shared) {
    return renderCard({ kicker: "Lekha", title: "Link not active", headline: "Ask the sender for a new link", badge: "Statement", color: "ink" });
  }
  const s = summarizeShare(shared, card);
  return renderCard({
    kicker: [s.business, s.typeLabel].filter(Boolean).join(" · "),
    title: s.ledgerName,
    subtitle: s.party && shared.ledger.ledger_type !== "personal" ? `with ${s.party}` : null,
    headline: s.headline,
    amount: s.amount,
    chips: s.chips,
    footer: s.sharedBy ? `Shared by ${s.sharedBy}` : "Shared with you on Lekha",
    badge: "Live statement",
    color: s.color,
  });
}
