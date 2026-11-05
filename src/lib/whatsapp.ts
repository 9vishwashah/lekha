/** WhatsApp click-to-chat with a prefilled message. Works on phones (app) and desktop (web). */
export function whatsappLink(text: string, to?: string | null) {
  return `https://wa.me/${to ?? ""}?text=${encodeURIComponent(text)}`;
}

/** A saved phone as a wa.me number: Indian 10-digit mobiles get +91; anything unclear gives null. */
export function whatsappNumber(phone: string | null | undefined) {
  const digits = (phone ?? "").replace(/[^\d+]/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^\+\d{10,15}$/.test(digits)) return digits.slice(1);
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  return null;
}
