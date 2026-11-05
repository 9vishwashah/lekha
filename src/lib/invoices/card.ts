import { createHash } from "node:crypto";

export interface InvoiceCard {
  invoice_no: string;
  invoice_type: string;
  title: string | null;
  amount: string | number;
  business: string | null;
  logo_path: string | null;
  card_color: string | null;
}

/**
 * A short mark of what the link preview shows. WhatsApp keeps a preview per link, so the only way
 * to replace an old one is a different link. This changes when the preview's content changes, and
 * not for anything else: a payment or a reminder leaves the link alone.
 */
export function cardVersion(card: InvoiceCard) {
  const shown = [card.invoice_no, card.invoice_type, card.title, card.amount, card.business, card.logo_path, card.card_color];
  return createHash("sha256").update(JSON.stringify(shown)).digest("hex").slice(0, 10);
}
