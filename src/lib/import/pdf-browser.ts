import { type Word, looksScrambled, wordsToGrid } from "./statement";
import type { Grid } from "./parse";

/**
 * Reads a bank statement PDF in the browser. The file never leaves the device: only the rows the
 * person confirms are sent, exactly as with Excel.
 *
 * 1. Uses the PDF's own text when it has readable text (most bank e-statements).
 * 2. Otherwise reads the pages with OCR: scanned statements, and banks such as India Post Payments
 *    Bank that scramble the text so it cannot be copied. The OCR engine and its English data are
 *    downloaded on first use (a few MB).
 */
export type PdfProgress = { stage: "reading" | "ocr"; page: number; pages: number };

export class PdfPasswordError extends Error {
  constructor(public readonly wrong: boolean) {
    super(wrong ? "That password didn't open the PDF. Try again." : "This statement is password-protected.");
  }
}

export class PdfNoTableError extends Error {}

async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  }
  return pdfjs;
}

export async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MAX_PAGES = 60;

export async function readStatementPdf(
  bytes: ArrayBuffer,
  options: { password?: string; onProgress?: (p: PdfProgress) => void } = {},
): Promise<{ grid: Grid; rows: number; ocr: boolean; pages: number }> {
  const pdfjs = await loadPdfJs();
  let doc;
  try {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), password: options.password, isEvalSupported: false }).promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === "PasswordException") throw new PdfPasswordError(err.code === 2);
    throw new PdfNoTableError("We couldn't open this PDF. Check it opens on your computer and try again.");
  }
  const pages = Math.min(doc.numPages, MAX_PAGES);

  // 1. The PDF's own text.
  const words: Word[] = [];
  for (let n = 1; n <= pages; n++) {
    options.onProgress?.({ stage: "reading", page: n, pages });
    const page = await doc.getPage(n);
    const { height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [, , , , x, y] = item.transform as number[];
      const h = item.height || Math.abs((item.transform as number[])[3]) || 8;
      words.push(...splitItem(n, item.str, x, height - y - h, item.width, h));
    }
  }
  if (!looksScrambled(words)) {
    const grid = wordsToGrid(words);
    if (grid && grid.rows > 0) {
      await doc.destroy();
      return { ...grid, ocr: false, pages };
    }
  }

  // 2. OCR, page by page.
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  const ocrWords: Word[] = [];
  try {
    const scale = 2.5;
    for (let n = 1; n <= pages; n++) {
      options.onProgress?.({ stage: "ocr", page: n, pages });
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      for (const b of data.blocks ?? [])
        for (const p of b.paragraphs)
          for (const l of p.lines)
            for (const w of l.words)
              ocrWords.push({ page: n, text: w.text, x0: w.bbox.x0 / scale, x1: w.bbox.x1 / scale, y0: w.bbox.y0 / scale, y1: w.bbox.y1 / scale });
      canvas.width = canvas.height = 0;
    }
  } finally {
    await worker.terminate();
    await doc.destroy();
  }
  const grid = wordsToGrid(ocrWords);
  if (!grid || grid.rows === 0) {
    throw new PdfNoTableError("We couldn't find a transactions table in this PDF. It needs columns like Date, Description, Debit/Withdrawal and Credit/Deposit.");
  }
  return { ...grid, ocr: true, pages };
}

/** pdf.js often returns a whole line as one item; split it into words with estimated positions. */
function splitItem(page: number, text: string, x: number, top: number, width: number, height: number): Word[] {
  const parts = text.split(/(\s{2,})/);
  if (parts.length === 1) return [{ page, text: text.trim(), x0: x, x1: x + width, y0: top, y1: top + height }];
  const perChar = width / Math.max(text.length, 1);
  const out: Word[] = [];
  let offset = 0;
  for (const part of parts) {
    if (part.trim()) out.push({ page, text: part.trim(), x0: x + offset * perChar, x1: x + (offset + part.length) * perChar, y0: top, y1: top + height });
    offset += part.length;
  }
  return out;
}
