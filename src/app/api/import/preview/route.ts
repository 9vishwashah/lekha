import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { MAX_IMPORT_BYTES, readWorkbook } from "@/lib/import/workbook";
import { detectHeader, guessLayout } from "@/lib/import/parse";

export const runtime = "nodejs";

const XLSX_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
  "",
]);

/** Reads an uploaded workbook into plain grids. Nothing is written to the database here. */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in to import" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an .xlsx file" }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".xlsx") || !XLSX_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Only .xlsx workbooks are supported. Save older .xls files as .xlsx first." }, { status: 415 });
  }
  if (file.size === 0 || file.size > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: "The file must be smaller than 4 MB. Split large sheets and import them one at a time." }, { status: 413 });
  }

  try {
    const bytes = await file.arrayBuffer();
    // Real xlsx files are zip archives: check the magic number before parsing.
    const head = new Uint8Array(bytes.slice(0, 4));
    if (head[0] !== 0x50 || head[1] !== 0x4b) {
      return NextResponse.json({ error: "This file is not a valid .xlsx workbook" }, { status: 415 });
    }
    const { sheets, fileHash } = await readWorkbook(bytes);
    return NextResponse.json({
      fileName: file.name,
      fileHash,
      sheets: sheets.map((s) => {
        const header = detectHeader(s.grid);
        return {
          name: s.name,
          grid: s.grid,
          truncated: s.truncated,
          headerRow: header.headerRow,
          mapping: header.mapping,
          confidence: header.confidence,
          layout: guessLayout(header.mapping),
        };
      }),
    });
  } catch {
    return NextResponse.json({ error: "We could not read this workbook. Check it opens in Excel and try again." }, { status: 422 });
  }
}
