import "server-only";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type ReportTable, cellText } from "./table";

/**
 * Professional statement PDF. Embeds Inter so ₹ and Indian names render correctly.
 * Wide tables (taxation) switch to A4 landscape. The header row repeats on every page.
 */
const INK = rgb(0.114, 0.114, 0.106); // #1D1D1B
const MUTED = rgb(0.37, 0.36, 0.32);
const RULE = rgb(0.86, 0.83, 0.78);
const BAND = rgb(0.96, 0.94, 0.9);

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
async function fonts() {
  if (!fontCache) {
    const dir = path.join(process.cwd(), "assets", "fonts");
    const [regular, bold] = await Promise.all([
      readFile(path.join(dir, "Inter_400Regular.ttf")),
      readFile(path.join(dir, "Inter_600SemiBold.ttf")),
    ]);
    fontCache = { regular, bold };
  }
  return fontCache;
}

function fit(text: string, font: PDFFont, size: number, width: number) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > width) t = t.slice(0, -1);
  return t + "…";
}

export async function toPDF(table: ReportTable, meta: { business: string; generatedAt: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await fonts();
  // Full fonts, not subsets: pdf-lib's subsetting drops glyphs from Inter (letters and ₹ vanish).
  const regular = await doc.embedFont(f.regular, { subset: false });
  const bold = await doc.embedFont(f.bold, { subset: false });
  doc.setTitle(table.title);
  doc.setProducer("Lekha");

  const [W, H] = table.landscape ? [842, 595] : [595, 842];
  const margin = 36;
  const usable = W - margin * 2;
  const size = table.columns.length > 9 ? 7 : 8.5;
  const rowH = size + 8;
  const weights = table.columns.map((c) => c.width ?? (c.kind === "money" ? 1.15 : c.kind === "date" ? 0.9 : 1.6));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / totalWeight) * usable);

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - margin;
  let pageNo = 1;

  const text = (p: PDFPage, s: string, x: number, yy: number, font: PDFFont, sz: number, color = INK) =>
    p.drawText(s, { x, y: yy, size: sz, font, color });

  const drawHeaderBlock = () => {
    text(page, meta.business, margin, y, bold, 9, MUTED);
    y -= 22;
    text(page, table.title, margin, y, bold, 18);
    y -= 16;
    for (const line of table.subtitle) {
      text(page, line, margin, y, regular, 9, MUTED);
      y -= 12;
    }
    y -= 6;
    // Summary figures in a band
    if (table.summary.length) {
      const cellW = usable / Math.min(table.summary.length, 4);
      const lines = Math.ceil(table.summary.length / 4);
      page.drawRectangle({ x: margin, y: y - lines * 34 + 8, width: usable, height: lines * 34, color: BAND });
      table.summary.forEach((s, i) => {
        const col = i % 4;
        const line = Math.floor(i / 4);
        const x = margin + 10 + col * cellW;
        const yy = y - line * 34;
        text(page, s.label, x, yy - 4, regular, 7.5, MUTED);
        text(page, fit(s.value, bold, 11, cellW - 16), x, yy - 18, bold, 11);
      });
      y -= lines * 34 + 12;
    }
  };

  const drawColumnHeader = () => {
    page.drawRectangle({ x: margin, y: y - rowH + 4, width: usable, height: rowH, color: INK });
    let x = margin;
    table.columns.forEach((c, i) => {
      const label = fit(c.label, bold, size, widths[i] - 6);
      const tx = c.kind === "money" ? x + widths[i] - 3 - bold.widthOfTextAtSize(label, size) : x + 3;
      text(page, label, tx, y - rowH + 9, bold, size, rgb(1, 1, 1));
      x += widths[i];
    });
    y -= rowH;
  };

  const drawRow = (row: Record<string, unknown>, font: PDFFont, shade: boolean) => {
    if (shade) page.drawRectangle({ x: margin, y: y - rowH + 4, width: usable, height: rowH, color: rgb(0.985, 0.975, 0.955) });
    let x = margin;
    table.columns.forEach((c, i) => {
      const s = fit(cellText((row[c.key] ?? null) as never, c.kind), font, size, widths[i] - 6);
      const tx = c.kind === "money" ? x + widths[i] - 3 - font.widthOfTextAtSize(s, size) : x + 3;
      text(page, s, tx, y - rowH + 9, font, size);
      x += widths[i];
    });
    y -= rowH;
  };

  const footer = () => {
    text(page, `Generated ${meta.generatedAt} · Page ${pageNo}`, margin, 20, regular, 7, MUTED);
    const note = "Computer-generated statement. Not a statutory GST or TDS return.";
    text(page, note, W - margin - regular.widthOfTextAtSize(note, 7), 20, regular, 7, MUTED);
  };

  drawHeaderBlock();
  drawColumnHeader();
  table.rows.forEach((row, i) => {
    if (y < margin + rowH * 2) {
      footer();
      page = doc.addPage([W, H]);
      pageNo += 1;
      y = H - margin;
      drawColumnHeader();
    }
    drawRow(row, regular, i % 2 === 1);
  });
  if (table.totals) {
    if (y < margin + rowH * 2) {
      footer();
      page = doc.addPage([W, H]);
      pageNo += 1;
      y = H - margin;
    }
    page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: margin + usable, y: y + 4 }, thickness: 0.8, color: RULE });
    drawRow(table.totals, bold, false);
  }
  if (table.footnote) {
    y -= 10;
    text(page, fit(table.footnote, regular, 7.5, usable), margin, y, regular, 7.5, MUTED);
  }
  footer();
  return doc.save();
}
