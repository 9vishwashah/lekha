import "server-only";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import type { Cell, Grid } from "./parse";

const MAX_ROWS = 10_000;
const MAX_COLS = 30;
// Vercel rejects request bodies over 4.5 MB, so stay safely under it.
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export interface SheetGrid {
  name: string;
  grid: Grid;
  truncated: boolean;
}

/** Reads every worksheet into plain cell values. Formulas contribute their cached result. */
export async function readWorkbook(bytes: ArrayBuffer): Promise<{ sheets: SheetGrid[]; fileHash: string }> {
  const buffer = Buffer.from(bytes);
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheets: SheetGrid[] = [];
  workbook.eachSheet((sheet) => {
    const grid: Grid = [];
    const rowCount = Math.min(sheet.rowCount, MAX_ROWS);
    const colCount = Math.min(sheet.columnCount, MAX_COLS);
    for (let r = 1; r <= rowCount; r++) {
      const row = sheet.getRow(r);
      const cells: Cell[] = [];
      for (let c = 1; c <= colCount; c++) cells.push(toCell(row.getCell(c).value));
      grid.push(cells);
    }
    while (grid.length && grid[grid.length - 1].every((c) => c === null)) grid.pop();
    sheets.push({ name: sheet.name, grid, truncated: sheet.rowCount > MAX_ROWS });
  });
  return { sheets, fileHash };
}

function toCell(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (value instanceof Date) {
    // ExcelJS returns date cells as UTC midnight of the calendar date.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "object") {
    if ("result" in value) return toCell((value as { result: ExcelJS.CellValue }).result);
    if ("richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
    if ("text" in value) return String((value as { text: unknown }).text);
    if ("error" in value) return null;
  }
  return String(value);
}
