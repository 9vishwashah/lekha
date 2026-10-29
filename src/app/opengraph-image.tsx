import { OG_SIZE, renderCard } from "@/lib/og";
import { appUrl } from "@/lib/env";

export const alt = "Lekha: ledgers for you and your businesses";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderCard(
    {
      kicker: "Ledgers · GST & TDS · Advances · Shared accounts",
      title: "For you & your businesses",
      headline: "Every khata, settled. Shared live on WhatsApp.",
      chips: ["₹ · lakh–crore", "April FY"],
      badge: new URL(appUrl()).host,
      color: "mustard",
    },
    { cache: "public" },
  );
}
