import { type Paise, divRound, percentOf, toRateMilli } from "./money";

/**
 * Tax engine. Mirrors app.compute_tax() in the database exactly (tests check parity):
 *   gst   = round(taxable × gstRate%)        cgst = round(gst / 2), sgst = gst − cgst (intra-state)
 *   gross = taxable + gst                    igst = gst (inter-state)
 *   tds   = round(base × tdsRate%)           base = taxable or gross, chosen per entry
 *   net   = gross − tds
 * Rates are inputs, never assumptions: the caller decides whether GST/TDS apply.
 */
export type GstType = "intra" | "inter" | "none";
export type TdsBase = "taxable" | "gross";

export interface TaxInput {
  taxable: Paise;
  gstApplicable: boolean;
  gstType: Exclude<GstType, "none">;
  gstRate: string;
  tdsApplicable: boolean;
  tdsRate: string;
  tdsBase: TdsBase;
}

export interface TaxBreakdown {
  taxable: Paise;
  gstType: GstType;
  gstRateMilli: bigint;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  gst: Paise;
  gross: Paise;
  tdsRateMilli: bigint;
  tdsBase: TdsBase;
  tds: Paise;
  net: Paise;
}

export function computeTax(input: TaxInput): TaxBreakdown {
  if (input.taxable < 0n) throw new Error("Taxable amount cannot be negative");
  const gstRateMilli = input.gstApplicable ? toRateMilli(input.gstRate) : 0n;
  const tdsRateMilli = input.tdsApplicable ? toRateMilli(input.tdsRate) : 0n;
  if (gstRateMilli > 50_000n) throw new Error("GST rate cannot exceed 50%");
  if (tdsRateMilli > 40_000n) throw new Error("TDS rate cannot exceed 40%");

  const gstType: GstType = input.gstApplicable ? input.gstType : "none";
  const gst = input.gstApplicable ? percentOf(input.taxable, gstRateMilli) : 0n;
  const cgst = gstType === "intra" ? divRound(gst, 2n) : 0n;
  const sgst = gstType === "intra" ? gst - cgst : 0n;
  const igst = gstType === "inter" ? gst : 0n;
  const gross = input.taxable + gst;
  const base = input.tdsBase === "gross" ? gross : input.taxable;
  const tds = input.tdsApplicable ? percentOf(base, tdsRateMilli) : 0n;

  return {
    taxable: input.taxable,
    gstType,
    gstRateMilli,
    cgst,
    sgst,
    igst,
    gst,
    gross,
    tdsRateMilli,
    tdsBase: input.tdsBase,
    tds,
    net: gross - tds,
  };
}

/** Breakdown from explicit amounts (spreadsheet import), keeping the sheet's own GST/TDS figures. */
export function taxFromAmounts(taxable: Paise, gst: Paise, tds: Paise, gstType: Exclude<GstType, "none">): TaxBreakdown {
  const effectiveType: GstType = gst > 0n ? gstType : "none";
  const cgst = effectiveType === "intra" ? divRound(gst, 2n) : 0n;
  const gross = taxable + gst;
  return {
    taxable,
    gstType: effectiveType,
    gstRateMilli: taxable > 0n ? divRound(gst * 100_000n, taxable) : 0n,
    cgst,
    sgst: effectiveType === "intra" ? gst - cgst : 0n,
    igst: effectiveType === "inter" ? gst : 0n,
    gst,
    gross,
    tdsRateMilli: taxable > 0n ? divRound(tds * 100_000n, taxable) : 0n,
    tdsBase: "taxable",
    tds,
    net: gross - tds,
  };
}

export const formatRate = (milli: bigint): string => {
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}%` : `${whole}%`;
};

/** Human explanation lines shown under the tax fields so the user can verify each step. */
export function explainTax(t: TaxBreakdown, fmt: (p: Paise) => string): string[] {
  const lines: string[] = [];
  if (t.gstType === "none") lines.push("No GST on this bill");
  else {
    lines.push(`GST ${formatRate(t.gstRateMilli)} of ${fmt(t.taxable)} = ${fmt(t.gst)}`);
    if (t.gstType === "intra") lines.push(`Split as CGST ${fmt(t.cgst)} + SGST ${fmt(t.sgst)}`);
    else lines.push(`Charged as IGST ${fmt(t.igst)}`);
  }
  lines.push(`Gross invoice = ${fmt(t.taxable)} + ${fmt(t.gst)} = ${fmt(t.gross)}`);
  if (t.tds > 0n || t.tdsRateMilli > 0n) {
    const base = t.tdsBase === "gross" ? t.gross : t.taxable;
    lines.push(`TDS ${formatRate(t.tdsRateMilli)} of ${t.tdsBase === "gross" ? "gross" : "taxable"} ${fmt(base)} = ${fmt(t.tds)}`);
  }
  lines.push(`Net after TDS = ${fmt(t.gross)} − ${fmt(t.tds)} = ${fmt(t.net)}`);
  return lines;
}
