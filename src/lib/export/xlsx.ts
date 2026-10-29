import "server-only";
import ExcelJS from "exceljs";
import { toDecimal } from "@/lib/domain/money";
import { type CellValue, type ReportTable, cellText } from "./table";

/**
 * Indian digit grouping (1,23,45,678) as an Excel number format.
 * Excel allows at most three sections when conditions are used, so negatives fall in the last
 * section with standard grouping. Paise only appear on cells that have them.
 */
const inrFormat = (decimals: boolean) => {
  const d = decimals ? ".00" : "";
  return `[>=10000000]"₹"##\\,##\\,##\\,##0${d};[>=100000]"₹"##\\,##\\,##0${d};"₹"#,##0${d}`;
};

const INK = "FF1D1D1B";
const MUTED = "FF5F5B52";
const BAND = "FFF4F0E8";
const RULE = "FFDDD5C7";

function toExcel(value: CellValue, kind: string): ExcelJS.CellValue {
  if (value === null || value === undefined || value === "") return null;
  if (kind === "money" && typeof value === "bigint") return Number(toDecimal(value));
  if (kind === "date" && typeof value === "string") {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return typeof value === "bigint" ? Number(value) : value;
}

export async function toXLSX(tables: ReportTable[], meta: { creator: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.creator;
  wb.created = new Date();

  for (const table of tables) {
    const cols = table.columns.length;
    const lastCol = ws_col(cols);
    const ws = wb.addWorksheet(table.title.slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "Report", {
      pageSetup: {
        paperSize: 9, // A4
        orientation: table.landscape ? "landscape" : "portrait",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      },
      properties: { defaultRowHeight: 18 },
    });

    // Title and context lines span the full table width.
    const banner = (text: string, font: Partial<ExcelJS.Font>, height?: number) => {
      const row = ws.addRow([text]);
      ws.mergeCells(`A${row.number}:${lastCol}${row.number}`);
      row.font = font;
      row.alignment = { vertical: "middle", wrapText: true };
      if (height) row.height = height;
      return row;
    };
    banner(meta.creator, { size: 10, color: { argb: MUTED } });
    banner(table.title, { size: 16, bold: true, color: { argb: INK } }, 26);
    for (const line of table.subtitle) banner(line, { size: 10, color: { argb: MUTED } });

    // Summary as label / value pairs, two per row, on a light band.
    if (table.summary.length) {
      ws.addRow([]);
      const pairsPerRow = cols >= 6 ? 2 : 1;
      const span = Math.max(1, Math.floor(cols / (pairsPerRow * 2)));
      for (let i = 0; i < table.summary.length; i += pairsPerRow) {
        const row = ws.addRow([]);
        table.summary.slice(i, i + pairsPerRow).forEach((s, j) => {
          const labelCol = 1 + j * span * 2;
          const valueCol = labelCol + span;
          const label = row.getCell(labelCol);
          const value = row.getCell(valueCol);
          label.value = s.label;
          label.font = { size: 10, color: { argb: MUTED } };
          value.value = s.value;
          value.font = { bold: true, size: 11, color: { argb: INK } };
          if (span > 1) {
            ws.mergeCells(row.number, labelCol, row.number, valueCol - 1);
            ws.mergeCells(row.number, valueCol, row.number, Math.min(valueCol + span - 1, cols));
          }
        });
        for (let c = 1; c <= cols; c++) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      }
    }
    ws.addRow([]);

    // Column header
    const header = ws.addRow(table.columns.map((c) => c.label));
    header.height = 22;
    header.eachCell((cell, i) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
      cell.alignment = { vertical: "middle", horizontal: table.columns[i - 1]?.kind === "money" || table.columns[i - 1]?.kind === "number" ? "right" : "left" };
    });
    ws.views = [{ state: "frozen", ySplit: header.number, showGridLines: false }];

    const styleRow = (r: ExcelJS.Row, zebra: boolean) => {
      table.columns.forEach((c, i) => {
        const cell = r.getCell(i + 1);
        if (c.kind === "money" && typeof cell.value === "number") cell.numFmt = inrFormat(!Number.isInteger(cell.value));
        if (c.kind === "date") cell.numFmt = "dd/mm/yyyy";
        cell.alignment = { vertical: "top", wrapText: c.kind === "text", horizontal: c.kind === "money" || c.kind === "number" ? "right" : "left" };
        cell.border = { bottom: { style: "hair", color: { argb: RULE } } };
        if (zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFBF9F5" } };
      });
    };

    table.rows.forEach((row, i) => styleRow(ws.addRow(table.columns.map((c) => toExcel(row[c.key] ?? null, c.kind))), i % 2 === 1));
    if (table.rows.length) {
      ws.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number + table.rows.length, column: cols } };
    }
    if (table.totals) {
      const t = ws.addRow(table.columns.map((c) => toExcel(table.totals![c.key] ?? null, c.kind)));
      styleRow(t, false);
      t.eachCell((cell) => {
        cell.font = { bold: true };
        cell.border = { top: { style: "thin", color: { argb: INK } }, bottom: { style: "double", color: { argb: INK } } };
      });
    }
    if (table.footnote) {
      ws.addRow([]);
      banner(table.footnote, { italic: true, size: 9, color: { argb: MUTED } });
    }

    // Column widths from the content, within sensible bounds.
    table.columns.forEach((c, i) => {
      const longest = Math.max(
        c.label.length,
        ...table.rows.slice(0, 500).map((r) => cellText(r[c.key] ?? null, c.kind).length),
        table.totals ? cellText(table.totals[c.key] ?? null, c.kind).length : 0,
      );
      const width = c.kind === "date" ? 12 : c.kind === "money" ? Math.max(14, longest + 2) : Math.min(48, Math.max(10, longest + 2));
      ws.getColumn(i + 1).width = width;
    });
    ws.headerFooter = { oddFooter: `&L${meta.creator} · ${table.title}&RPage &P of &N` };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 1 → A, 27 → AA */
function ws_col(n: number) {
  let s = "";
  for (let x = Math.max(1, n); x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
