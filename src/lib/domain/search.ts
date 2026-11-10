/**
 * Ledger search, shared by the ledger screen and the public share page.
 * Words match the payee, description, reference and entry number (any case). Amounts match however
 * they are typed: 78981, 78,981, ₹78,981 or 78981.34. Values may arrive as numbers or text.
 */
export interface Searchable {
  description?: unknown;
  counterparty?: unknown;
  reference_no?: unknown;
  voucher_no?: unknown;
  amount?: unknown;
}

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** The plain digits of an amount: "78981.00" → "78981", "1170000.5" → "1170000.5". */
function plainAmount(v: unknown) {
  const s = text(v).replace(/[₹,\s]/g, "");
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export function matchesSearch(row: Searchable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if ([row.description, row.counterparty, row.reference_no, row.voucher_no].some((v) => text(v).toLowerCase().includes(q))) return true;
  const digits = q.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d*)?$/.test(digits)) return false;
  const amount = text(row.amount);
  return amount.includes(digits) || plainAmount(row.amount).includes(digits.replace(/\.$/, ""));
}

/** One lowercase string to search, for lists filtered in the browser. */
export function searchText(row: Searchable) {
  return [row.description, row.counterparty, row.reference_no, row.voucher_no, text(row.amount), plainAmount(row.amount)].map(text).join(" ").toLowerCase();
}
