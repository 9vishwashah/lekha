import "server-only";
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, degrees, rgb, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatINR } from "@/lib/domain/money";
import { formatDate, formatDateLong } from "@/lib/domain/dates";
import { TEMPLATE_STYLE, cellText, docColumns, metaRows, onColor, tint, totalRows, type InvoiceDoc } from "./doc";
import { qrRuns } from "./qr";

/**
 * The invoice as a real PDF, drawn from the saved data (never a screenshot of the preview). Text is
 * wrapped, not clipped; the table header repeats on every page; totals are never split from the
 * table; and each page carries its number. Inter is embedded so ₹ and Indian names render.
 */
const W = 595.28;
const H = 841.89;
const M = 40;
const INK = rgb(0.114, 0.114, 0.106);
const MUTED = rgb(0.37, 0.36, 0.32);
const RULE = rgb(0.86, 0.85, 0.82);
const PANEL = rgb(0.955, 0.95, 0.94);
const WHITE = rgb(1, 1, 1);

const hex = (h: string): RGB => {
  const v = h.replace("#", "");
  return rgb(parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255);
};

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
async function fonts() {
  if (!fontCache) {
    const dir = path.join(process.cwd(), "assets", "fonts");
    const [regular, bold] = await Promise.all([readFile(path.join(dir, "Inter_400Regular.ttf")), readFile(path.join(dir, "Inter_600SemiBold.ttf"))]);
    fontCache = { regular, bold };
  }
  return fontCache;
}

/** Word wrap that also breaks a single word too long for the line (URLs, account numbers). */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      line = "";
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) out.push(line);
  }
  return out;
}

async function loadImage(doc: PDFDocument, url: string | null): Promise<PDFImage | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes);
  } catch {
    // A missing logo must never stop the invoice being produced.
  }
  return null;
}

export async function invoicePdf(inv: InvoiceDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const f = await fonts();
  // Full fonts, not subsets: pdf-lib's subsetting drops glyphs from Inter (letters and ₹ vanish).
  const regular = await pdf.embedFont(f.regular, { subset: false });
  const bold = await pdf.embedFont(f.bold, { subset: false });
  pdf.setTitle(`${inv.heading} ${inv.number ?? ""}`.trim());
  pdf.setAuthor(inv.seller.name);
  pdf.setProducer("Lekha");
  pdf.setCreator("Lekha");

  const [logo, signature, stamp, fixedQr] = await Promise.all([
    loadImage(pdf, inv.seller.logo),
    loadImage(pdf, inv.seller.signature),
    loadImage(pdf, inv.seller.stamp),
    loadImage(pdf, inv.payment.upi?.qrImage ?? null),
  ]);

  const style = TEMPLATE_STYLE[inv.template];
  const brand = hex(inv.brand);
  const onBrand = hex(onColor(inv.brand));
  const accent = hex(inv.accent);
  const onAccent = hex(onColor(inv.accent));
  const project = inv.template === "project";
  const wash = hex(tint(inv.brand));
  const body = style.dense ? 8.5 : 9.5;
  const leading = body * 1.38;
  const usable = W - M * 2;
  const footerSpace = 46;

  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, yy: number, size = body, font = regular, color = INK, p = page) => p.drawText(s, { x, y: yy, size, font, color });
  const right = (s: string, xr: number, yy: number, size = body, font = regular, color = INK) => text(s, xr - font.widthOfTextAtSize(s, size), yy, size, font, color);
  /** Letter-spaced small capitals, as used for section labels. */
  const tracked = (s: string, x: number, yy: number, size: number, font: PDFFont, color: RGB, gap = 1.4) => {
    let cx2 = x;
    for (const ch of s) {
      text(ch, cx2, yy, size, font, color);
      cx2 += font.widthOfTextAtSize(ch, size) + gap;
    }
    return cx2;
  };
  /** A labelled divider: colour bar, spaced label, hairline to the margin. */
  const sectionLabel = (label: string) => {
    ensure(26);
    page.drawRectangle({ x: M, y: y - 13, width: 3.5, height: 13, color: brand });
    const end = tracked(label.toUpperCase(), M + 11, y - 10.5, 7.5, bold, INK, 1.8);
    page.drawRectangle({ x: end + 6, y: y - 7, width: W - M - end - 6, height: 0.5, color: RULE });
    y -= 22;
  };
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const ensure = (h: number) => {
    if (y - h < M + footerSpace) {
      newPage();
      return true;
    }
    return false;
  };
  const para = (s: string, x: number, width: number, size = body, font = regular, color = INK, lh = size * 1.38) => {
    for (const line of wrapText(s, font, size, width)) {
      ensure(lh);
      if (line) text(line, x, y - size, size, font, color);
      y -= lh;
    }
  };

  // -------------------------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------------------------
  const sellerLines = [inv.seller.address, [inv.seller.phone, inv.seller.email].filter(Boolean).join(" · "), inv.seller.website, inv.seller.gstin ? `GSTIN: ${inv.seller.gstin}` : null].filter(Boolean) as string[];

  const drawLogo = (x: number, top: number, maxW: number, maxH: number) => {
    if (!logo) return 0;
    const s = Math.min(maxW / logo.width, maxH / logo.height);
    page.drawImage(logo, { x, y: top - logo.height * s, width: logo.width * s, height: logo.height * s });
    return logo.width * s;
  };

  if (project) {
    // Branded letterhead: logo, a rule, then the contact block; a line with diamond ends below.
    page.drawRectangle({ x: 0, y: H - 16, width: W * 0.54, height: 16, color: brand });
    const top = H - 34;
    let bottom = top - 58;
    if (logo) drawLogo(M, top, 210, 62);
    else text(inv.seller.name, M, top - 24, 22, bold, brand);
    const contact = [
      inv.seller.email && ["Email :", inv.seller.email],
      inv.seller.phone && ["Phone No:", inv.seller.phone],
      inv.seller.address && ["Address:", inv.seller.address],
      inv.seller.gstin && ["GSTIN:", inv.seller.gstin],
    ].filter(Boolean) as string[][];
    if (contact.length) {
      const cx0 = W * 0.62;
      let cy = top - 6;
      for (const [label, value] of contact) {
        const lw = bold.widthOfTextAtSize(label, 8.8) + 4;
        text(label, cx0 + 10, cy - 8.8, 8.8, bold);
        const lines = wrapText(value, regular, 8.8, W - M - cx0 - 14 - lw);
        lines.forEach((l, i) => text(l, cx0 + 10 + lw, cy - 8.8 - i * 12, 8.8));
        cy -= Math.max(1, lines.length) * 12 + 4;
      }
      page.drawRectangle({ x: cx0, y: cy + 2, width: 1.2, height: top - 2 - (cy + 2), color: INK });
      bottom = Math.min(bottom, cy - 4);
    }
    y = bottom - 8;
    page.drawRectangle({ x: M + 4, y: y - 0.8, width: usable - 8, height: 1.6, color: INK });
    for (const dx of [M + 3, W - M - 3]) page.drawRectangle({ x: dx, y: y - 4.2, width: 6, height: 6, color: INK, rotate: degrees(45) });
    y -= 26;
    text("To,", M, y, 13.5);
    const dateText = `Date: ${formatDateLong(inv.date)}`;
    right(dateText, W - M, y, 12.5, bold);
    y -= 21;
    const primary = inv.client.business || inv.client.name;
    text(primary, M, y, 16.5, bold);
    y -= 15;
    const sub = [inv.client.business && inv.client.business !== inv.client.name ? inv.client.name : null, inv.client.contact, inv.client.address, inv.client.gstin && `GSTIN: ${inv.client.gstin}`].filter(Boolean) as string[];
    for (const l of sub.flatMap((v) => wrapText(v, regular, 10.5, usable * 0.7))) {
      text(l, M, y, 10.5);
      y -= 13.5;
    }
    y -= 8;
    const heading = inv.title ? `${inv.heading === "INVOICE" ? "Invoice" : inv.heading} - ${inv.title}` : inv.heading;
    for (const l of wrapText(heading, bold, 16, usable)) {
      text(l, (W - bold.widthOfTextAtSize(l, 16)) / 2, y - 12, 16, bold);
      y -= 21;
    }
    y -= 6;
    let mx = tracked("INVOICE NO.", M, y, 6.8, bold, MUTED, 1.6);
    mx += 8;
    const no = inv.number ?? "Assigned when issued";
    text(no, mx, y, 9.5, bold);
    const payText = [inv.paymentTerms ?? (inv.due ? `Due ${formatDate(inv.due)}` : null), inv.payment.upi ? "UPI" : inv.payment.bank ? "Bank transfer" : null].filter(Boolean).join(" · ");
    if (payText) {
      const px = W * 0.54;
      const after = tracked("PAYMENT", px, y, 6.8, bold, MUTED, 1.6);
      text(payText, after + 8, y, 9.5, bold, inv.accent === "#eac119" ? brand : accent);
    }
    y -= 20;
    sectionLabel(inv.type === "project" ? "Deliverables" : "Details");
  } else if (style.header === "band") {
    const band = 112;
    page.drawRectangle({ x: 0, y: H - band, width: W, height: band, color: brand });
    const top = H - 26;
    const leftX = M;
    let ly = top;
    if (logo) {
      page.drawRectangle({ x: M - 6, y: top - 46, width: 104, height: 52, color: WHITE });
      drawLogo(M, top + 2, 92, 42);
      ly -= 58;
    } else {
      text(inv.seller.name, leftX, ly - 18, 18, bold, onBrand);
      ly -= 34;
    }
    for (const l of wrapText([inv.seller.phone, inv.seller.email].filter(Boolean).join(" · "), regular, 8, 300).slice(0, 1)) text(l, leftX, ly - 8, 8, regular, onBrand);
    right(inv.heading, W - M, top - 20, inv.heading.length > 10 ? 18 : 24, bold, onBrand);
    if (inv.number) right(inv.number, W - M, top - 38, 9.5, regular, onBrand);
    right(formatDate(inv.date), W - M, top - 52, 9, regular, onBrand);
    y = H - band - 22;
    if (inv.seller.address || inv.seller.gstin) {
      const small = [inv.seller.address, inv.seller.gstin ? `GSTIN ${inv.seller.gstin}` : null].filter(Boolean).join("  ·  ");
      para(small, M, usable, 8, regular, MUTED);
      y -= 6;
    }
  } else {
    const startY = y;
    const logoLeft = !inv.logoRight;
    let textX = M;
    let blockBottom = y;
    if (logo) {
      const w = drawLogo(logoLeft ? M : W - M - 150, y + 4, 150, 56);
      if (!logoLeft) textX = M;
      blockBottom = y - 60 + (w ? 0 : 60);
    } else {
      text(inv.seller.name, M, y - 18, 18, bold, brand);
      blockBottom = y - 26;
    }
    let sy = blockBottom - 4;
    for (const line of sellerLines) {
      for (const l of wrapText(line, regular, 8.2, 280)) {
        text(l, textX, sy - 8, 8.2, regular, MUTED);
        sy -= 11;
      }
    }
    if (logoLeft || !logo) {
      right(inv.heading, W - M, startY - 22, inv.heading.length > 10 ? 18 : 24, bold, brand);
      let my = startY - 38;
      if (inv.number) {
        right(`Invoice No.: ${inv.number}`, W - M, my, 9, regular, MUTED);
        my -= 12;
      }
      right(`Date: ${formatDate(inv.date)}`, W - M, my, 9, regular, MUTED);
    } else {
      text(inv.heading, M, startY - 22, 18, bold, brand);
    }
    y = Math.min(sy, startY - 66) - 8;
    if (style.table === "solid" && inv.template === "project") {
      page.drawRectangle({ x: M, y: y - 3, width: usable, height: 2.4, color: brand });
      page.drawRectangle({ x: M, y: y - 3, width: 90, height: 2.4, color: accent });
    } else {
      page.drawRectangle({ x: M, y: y - 2, width: usable, height: inv.template === "minimal" ? 0.6 : 1.6, color: inv.template === "minimal" ? RULE : brand });
    }
    y -= 16;
  }

  // -------------------------------------------------------------------------------------------
  // Bill to and the invoice facts
  // -------------------------------------------------------------------------------------------
  if (!project) {
    const billLines = [inv.client.business && inv.client.business !== inv.client.name ? inv.client.business : null, inv.client.contact ? `Attn: ${inv.client.contact}` : null, inv.client.address, [inv.client.state, inv.client.country !== "India" ? inv.client.country : null].filter(Boolean).join(", ") || null, inv.client.gstin ? `GSTIN: ${inv.client.gstin}` : null].filter(Boolean) as string[];
    // Number and date already sit in the header.
    const facts = metaRows(inv).filter((r) => r.label !== "Invoice No." && r.label !== "Date");
    const billW = facts.length ? usable * 0.58 : usable;
    const billText = billLines.flatMap((l) => wrapText(l, regular, body, billW - (style.panel ? 24 : 0)));
    const billH = 18 + 15 + billText.length * leading + (style.panel ? 16 : 0);
    const factsH = facts.length * 15 + (style.panel ? 16 : 0);
    const blockH = Math.max(billH, factsH);
    if (style.panel) page.drawRectangle({ x: M, y: y - blockH, width: usable, height: blockH, color: PANEL });
    const pad = style.panel ? 12 : 0;
    let by = y - pad;
    text("BILL TO", M + pad, by - 8, 7.5, bold, brand);
    by -= 16;
    text(inv.client.name, M + pad, by - 10.5, 11, bold);
    by -= 16;
    for (const l of billText) {
      text(l, M + pad, by - body, body);
      by -= leading;
    }
    let fy = y - pad - 8;
    for (const r of facts) {
      const value = wrapText(r.value, bold, body - 0.5, usable * 0.26)[0] ?? "";
      right(value, W - M - pad, fy, body - 0.5, bold);
      right(r.label, W - M - pad - bold.widthOfTextAtSize(value, body - 0.5) - 10, fy, body - 1, regular, MUTED);
      fy -= 15;
    }
    y -= blockH + 14;

    if (inv.title) {
      para(inv.title, M, usable, 11.5, bold);
      y -= 6;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Table
  // -------------------------------------------------------------------------------------------
  const cols = docColumns(inv);
  const weightSum = cols.reduce((a, c) => a + c.weight, 0);
  const cw = cols.map((c) => (c.weight / weightSum) * usable);
  const cx = cw.reduce<number[]>((acc, w, i) => [...acc, (acc[i - 1] ?? M) + (i ? cw[i - 1] : 0)], []);
  const cellPad = 6;
  const headH = 24;

  const tableHead = () => {
    if (style.table === "solid") page.drawRectangle({ x: M, y: y - headH, width: usable, height: headH, color: brand });
    else page.drawRectangle({ x: M, y: y - headH, width: usable, height: 0.8, color: INK });
    const color = style.table === "solid" ? onBrand : MUTED;
    cols.forEach((c, i) => {
      const label = c.label.toUpperCase();
      if (project && c.align === "left") tracked(label, cx[i] + cellPad, y - 15, 7, bold, color, 1.6);
      else if (c.align === "right") right(label, cx[i] + cw[i] - cellPad, y - 15, 7.5, bold, color);
      else text(label, cx[i] + cellPad, y - 15, 7.5, bold, color);
    });
    y -= headH;
  };

  ensure(headH + 40);
  tableHead();

  const summary = totalRows(inv);
  const bandH = style.total === "band" ? 34 : 24;
  const totalsH = summary.length * 16 + bandH + 32;

  inv.items.forEach((item, idx) => {
    const cells = cols.map((c, i) => {
      const inner = cw[i] - cellPad * 2;
      if (c.key === "item") {
        const nameLines = wrapText(item.name, bold, body, inner);
        const extra: string[] = [];
        if (inv.type !== "project" && item.description) extra.push(...wrapText(item.description, regular, body - 1, inner));
        if (item.sku) extra.push(...wrapText(`SKU ${item.sku}`, regular, body - 1.5, inner));
        return { nameLines, extra, url: item.url ? wrapText(item.url, regular, body - 1.5, inner) : [] };
      }
      return { nameLines: wrapText(cellText(item, c.key), regular, c.key === "description" ? body - 0.5 : body, inner), extra: [] as string[], url: [] as string[] };
    });
    const lh = leading;
    const rowH = Math.max(...cells.map((c) => c.nameLines.length * lh + c.extra.length * (lh - 1) + c.url.length * (lh - 1))) + 12;

    // A row taller than a page is split across pages line by line, so no text is ever lost.
    if (rowH > H - M * 2 - footerSpace - headH) {
      for (const para of [item.name, item.description ?? ""]) {
        for (const line of wrapText(para, regular, body, usable - 90)) {
          if (ensure(lh)) tableHead();
          if (line) text(line, M + cellPad, y - body, body);
          y -= lh;
        }
      }
      right(formatINR(item.amount), W - M - cellPad, y - body, body, bold);
      y -= lh + 6;
      return;
    }
    // The last row travels with the totals, so they never sit alone at the top of a page.
    if (ensure(idx === inv.items.length - 1 ? rowH + totalsH : rowH)) tableHead();
    if (style.zebra && idx % 2 === 1) page.drawRectangle({ x: M, y: y - rowH, width: usable, height: rowH, color: wash });
    cols.forEach((c, i) => {
      const cell = cells[i];
      let ty = y - 6;
      const font = c.key === "item" || c.key === "amount" ? bold : regular;
      const size = c.key === "description" ? body - 0.5 : body;
      for (const line of cell.nameLines) {
        if (c.align === "right") right(line, cx[i] + cw[i] - cellPad, ty - size, size, font, c.key === "n" ? brand : INK);
        else text(line, cx[i] + cellPad, ty - size, size, c.key === "n" ? bold : font, c.key === "n" ? brand : INK);
        ty -= lh;
      }
      for (const line of cell.url) {
        text(line, cx[i] + cellPad, ty - (body - 1.5), body - 1.5, regular, project && inv.accent !== "#eac119" ? accent : brand);
        ty -= lh - 1;
      }
      for (const line of cell.extra) {
        text(line, cx[i] + cellPad, ty - (body - 1), body - 1, regular, MUTED);
        ty -= lh - 1;
      }
    });
    y -= rowH;
    if (!style.zebra) page.drawRectangle({ x: M, y, width: usable, height: 0.5, color: RULE });
  });
  y -= 10;

  // -------------------------------------------------------------------------------------------
  // Totals: kept together
  // -------------------------------------------------------------------------------------------
  ensure(totalsH);
  const col2 = usable * 0.42;
  for (const r of summary) {
    right(r.value, W - M - cellPad, y - body, body);
    right(r.label, W - M - col2 + 70, y - body, body, regular, MUTED);
    y -= 16;
  }
  if (style.total === "band") {
    page.drawRectangle({ x: M, y: y - bandH, width: usable, height: bandH, color: accent });
    tracked("TOTAL PAYABLE", M + 14, y - bandH / 2 - 3.5, 8.5, bold, onAccent, 2.2);
    right(formatINR(inv.grand), W - M - 14, y - bandH / 2 - 6, 17, bold, onAccent);
  } else {
    page.drawRectangle({ x: M + usable - col2 - 10, y: y - bandH, width: col2 + 10, height: bandH, color: PANEL });
    text("GRAND TOTAL", M + usable - col2, y - bandH / 2 - 3.5, 9.5, bold);
    right(formatINR(inv.grand), W - M - cellPad, y - bandH / 2 - 4, 11.5, bold);
  }
  y -= bandH + 8;
  para(`Amount in words: ${inv.words}`, M, usable, 8.2, regular, MUTED);
  if (inv.received > 0n) {
    y -= 2;
    ensure(14);
    right(`Received ${formatINR(inv.received)}  ·  Balance ${formatINR(inv.balance)}`, W - M - cellPad, y - 9, 9, bold);
    y -= 14;
  }
  y -= 8;

  // -------------------------------------------------------------------------------------------
  // Notes, bank, terms
  // -------------------------------------------------------------------------------------------
  if (inv.notes) {
    para(inv.notes, M, usable, body - 1, regular, MUTED);
    y -= 8;
  }

  const panel = (x: number, width: number, title: string, lines: string[], top: number, minH = 0) => {
    const wrapped = lines.flatMap((l) => wrapText(l, regular, body - 0.5, width - 24));
    const h = Math.max(minH, 28 + wrapped.length * (leading - 0.5) + 8);
    page.drawRectangle({ x, y: top - h, width, height: h, color: PANEL });
    text(title, x + 12, top - 18, 8, bold, brand);
    let ty = top - 28;
    for (const l of wrapped) {
      text(l, x + 12, ty - (body - 0.5), body - 0.5);
      ty -= leading - 0.5;
    }
    return h;
  };

  const p = inv.payment;
  const bank = p.bank
    ? [p.bank.holder && `Account holder: ${p.bank.holder}`, p.bank.name && `Bank: ${p.bank.name}`, p.bank.branch && `Branch: ${p.bank.branch}`, `Account no.: ${p.bank.account}`, p.bank.ifsc && `IFSC: ${p.bank.ifsc}`].filter(Boolean) as string[]
    : null;
  const other = [p.cash && "Cash accepted", p.cheque && `Cheques payable to ${p.bank?.holder ?? inv.seller.name}`, p.other, p.instructions].filter(Boolean) as string[];
  const left = bank ? { title: "BANK DETAILS", lines: bank } : other.length ? { title: "PAYMENT", lines: other } : null;
  const rightPanel = inv.terms ? { title: "TERMS & CONDITIONS", lines: [inv.terms] } : bank && other.length ? { title: "PAYMENT", lines: other } : null;

  if (left || rightPanel) {
    const half = (usable - 12) / 2;
    const estimate = (b: { lines: string[] } | null) => (b ? 36 + b.lines.flatMap((l) => wrapText(l, regular, body - 0.5, half - 24)).length * (leading - 0.5) : 0);
    const h = Math.max(estimate(left), estimate(rightPanel));
    if (h > H - M * 2 - footerSpace) {
      // Very long terms: flow as text instead of a panel.
      if (left) y -= panel(M, half, left.title, left.lines, y) + 10;
      if (rightPanel) {
        ensure(30);
        text(rightPanel.title, M, y - 8, 8, bold, brand);
        y -= 14;
        para(rightPanel.lines.join("\n"), M, usable, body - 0.5);
      }
    } else {
      ensure(h);
      const top = y;
      const h1 = left ? panel(M, rightPanel ? half : usable, left.title, left.lines, top, rightPanel ? h : 0) : 0;
      const h2 = rightPanel ? panel(left ? M + half + 12 : M, left ? half : usable, rightPanel.title, rightPanel.lines, top, left ? h : 0) : 0;
      y = top - Math.max(h1, h2) - 10;
    }
  }

  // -------------------------------------------------------------------------------------------
  // QR codes: payment and digital copy are separate and labelled
  // -------------------------------------------------------------------------------------------
  const qrBlock = (x: number, width: number, top: number, drawCode: (x: number, y: number, s: number) => void, title: string, lines: string[]) => {
    const h = 88;
    page.drawRectangle({ x, y: top - h, width, height: h, color: PANEL });
    page.drawRectangle({ x: x + 8, y: top - 80, width: 72, height: 72, color: WHITE });
    drawCode(x + 12, top - 76, 64);
    text(title, x + 90, top - 22, 8, bold, brand);
    let ty = top - 34;
    for (const l of lines.flatMap((v) => wrapText(v, regular, 8.5, width - 102))) {
      text(l, x + 90, ty - 8, 8.5);
      ty -= 11.5;
    }
  };
  const vector = (data: string) => (x: number, yy: number, s: number) => {
    const { size, runs } = qrRuns(data);
    const m = s / size;
    for (const r of runs) page.drawRectangle({ x: x + r.x * m, y: yy + s - (r.y + 1) * m, width: r.w * m + 0.05, height: m + 0.05, color: INK });
  };
  const blocks: { code: (x: number, y: number, s: number) => void; title: string; lines: string[] }[] = [];
  if (p.upi && (p.upi.link || fixedQr)) {
    blocks.push({
      code: p.upi.link ? vector(p.upi.link) : (x, yy, s) => page.drawImage(fixedQr!, { x, y: yy, width: s, height: s }),
      title: "PAY BY UPI",
      lines: ["Scan with any UPI app to pay.", `UPI ID: ${p.upi.id}`, ...(p.upi.number ? [`Number: ${p.upi.number}`] : [])],
    });
  } else if (p.upi) {
    text(`UPI ID: ${p.upi.id}`, M, y - 9, 9, bold);
    y -= 16;
  }
  if (inv.digitalUrl) blocks.push({ code: vector(inv.digitalUrl), title: "DIGITAL COPY", lines: ["Scan to view or download this invoice."] });
  if (project && p.upi && blocks.length && blocks[0].title === "PAY BY UPI") {
    // One bordered card: a large payment QR with the details beside it, digital copy at the end.
    const h = 136;
    ensure(h + 30);
    sectionLabel("Pay via UPI");
    const top = y;
    page.drawRectangle({ x: M, y: top - h, width: usable, height: h, borderColor: brand, borderWidth: 0.8, color: WHITE });
    blocks[0].code(M + 16, top - h + 16, 104);
    const tx = M + 144;
    tracked("PAYMENT MODE", tx, top - 24, 6.5, bold, brand, 1.5);
    text("UPI", tx, top - 40, 13, bold);
    tracked(p.upi.number ? "UPI NUMBER" : "UPI ID", tx, top - 60, 6.5, bold, brand, 1.5);
    text(p.upi.number ?? p.upi.id, tx, top - 76, 13, bold);
    if (p.upi.payee) text(p.upi.payee, tx, top - 91, 9.5, regular, MUTED);
    text("Scan the QR or pay to the number.", tx, top - 106, 8.5, regular, MUTED);
    if (inv.paymentTerms) tracked(inv.paymentTerms.toUpperCase().slice(0, 34), tx, top - 120, 6.5, bold, brand, 1.5);
    if (inv.digitalUrl) {
      const qx = W - M - 92;
      blocks[1].code(qx + 8, top - 90, 72);
      const label = "Digital copy";
      text(label, qx + 8 + (72 - regular.widthOfTextAtSize(label, 7.5)) / 2, top - 104, 7.5, regular, MUTED);
    }
    y = top - h - 12;
  } else if (blocks.length) {
    ensure(96);
    const half = (usable - 12) / 2;
    const top = y;
    blocks.forEach((b, i) => qrBlock(i === 0 ? M : M + half + 12, half, top, b.code, b.title, b.lines));
    y = top - 88 - 12;
  }

  // -------------------------------------------------------------------------------------------
  // Signatory
  // -------------------------------------------------------------------------------------------
  if (inv.seller.signatoryName || signature || stamp) {
    ensure(92);
    right("Authorized Signatory", W - M, y - 10, 9.5);
    y -= 18;
    const imgs = [signature, stamp].filter(Boolean) as PDFImage[];
    let ix = W - M;
    for (const img of imgs.reverse()) {
      const s = Math.min(90 / img.width, 44 / img.height);
      ix -= img.width * s;
      page.drawImage(img, { x: ix, y: y - 44, width: img.width * s, height: img.height * s });
      ix -= 4;
    }
    if (imgs.length) y -= 48;
    if (inv.seller.signatoryName) {
      right(inv.seller.signatoryName, W - M, y - 10, 9.5, bold);
      y -= 13;
    }
    if (inv.seller.signatoryTitle) {
      right(inv.seller.signatoryTitle, W - M, y - 9, 8.5, regular, MUTED);
      y -= 12;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Footer on every page
  // -------------------------------------------------------------------------------------------
  const pages = pdf.getPages();
  const contact = inv.footer || [inv.seller.phone, inv.seller.email].filter(Boolean).join(" · ");
  pages.forEach((pg, i) => {
    if (project) {
      pg.drawRectangle({ x: W * 0.34, y: 0, width: W * 0.66, height: 14, color: accent });
      if (i > 0) pg.drawRectangle({ x: 0, y: H - 16, width: W * 0.54, height: 16, color: brand });
    }
    pg.drawRectangle({ x: M, y: M + 18, width: usable, height: 0.5, color: RULE });
    if (contact) {
      const line = wrapText(contact, regular, 7.5, usable - 80)[0] ?? "";
      pg.drawText(line, { x: M, y: M + 6, size: 7.5, font: regular, color: MUTED });
    }
    const label = `Page ${i + 1} of ${pages.length}`;
    pg.drawText(label, { x: W - M - regular.widthOfTextAtSize(label, 7.5), y: M + 6, size: 7.5, font: regular, color: MUTED });
  });

  return pdf.save();
}
