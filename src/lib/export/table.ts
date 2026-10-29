import { type Paise, formatINR, toDecimal } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/dates";

/**
 * A format-neutral report table. Ledger statements, expense lists and tax summaries are built
 * once into this shape from the shared domain calculations, then rendered to XLSX, CSV or PDF.
 * Every format therefore shows the same numbers as the screen.
 */
export type ColumnKind = "text" | "date" | "money" | "number";

export interface Column {
  key: string;
  label: string;
  kind: ColumnKind;
  width?: number; // relative weight for PDF layout
}

export type CellValue = string | number | Paise | null;

export interface ReportTable {
  title: string;
  subtitle: string[];
  summary: { label: string; value: string }[];
  columns: Column[];
  rows: Record<string, CellValue>[];
  totals?: Record<string, CellValue>;
  landscape?: boolean;
  footnote?: string;
}

export function cellText(value: CellValue, kind: ColumnKind, forCsv = false): string {
  if (value === null || value === undefined || value === "") return "";
  if (kind === "money" && typeof value === "bigint") return forCsv ? toDecimal(value) : formatINR(value);
  if (kind === "date" && typeof value === "string") return formatDate(value);
  return String(value);
}

export function toCSV(table: ReportTable): string {
  const escape = (s: string) => (/[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s);
  const lines: string[] = [];
  lines.push(table.columns.map((c) => escape(c.label)).join(","));
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => escape(cellText(row[c.key] ?? null, c.kind, true))).join(","));
  }
  if (table.totals) {
    lines.push(table.columns.map((c) => escape(cellText(table.totals![c.key] ?? null, c.kind, true))).join(","));
  }
  // BOM so Excel opens UTF-8 (₹, Hindi names) correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function safeFileName(name: string) {
  return name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "export";
}
