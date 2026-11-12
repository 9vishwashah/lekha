/**
 * Lekha's email look, shared by every email: seashell canvas, one solid colour block with the big
 * figure, plain rows, one black pill button. Table layout with inline styles, because that is what
 * email clients (Gmail, Outlook, Apple Mail) render reliably. Every value is escaped.
 */
export type EmailTone = "mustard" | "tea" | "lavender" | "pink" | "ink" | "sky";

const C = {
  canvas: "#f2eee7",
  surface: "#fbfaf7",
  line: "#ddd5c7",
  ink: "#1d1d1b",
  ink2: "#57534b",
  ink3: "#6f6a60",
  in: "#1f6b5f",
  out: "#b33a39",
  seashell: "#eae4da",
};

const BLOCK: Record<EmailTone, { bg: string; fg: string; sub: string }> = {
  mustard: { bg: "#eac119", fg: C.ink, sub: "#4a3d0a" },
  tea: { bg: "#245e55", fg: C.seashell, sub: "#c9dcd6" },
  lavender: { bg: "#808bc5", fg: C.ink, sub: "#262b45" },
  pink: { bg: "#eaa7c7", fg: C.ink, sub: "#4d2a3b" },
  ink: { bg: C.ink, fg: C.seashell, sub: "#b9b3a8" },
  sky: { bg: "#9ed6df", fg: C.ink, sub: "#1f4248" },
};

const DISPLAY = "'Bricolage Grotesque','Arial Black','Helvetica Neue',Arial,sans-serif";
const BODY = "'Geist','Helvetica Neue',Helvetica,Arial,sans-serif";

export const esc = (s: string | number | null | undefined) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export interface EmailRow {
  label: string;
  value: string;
  sub?: string;
  tone?: "in" | "out";
}

export interface EmailContent {
  /** Hidden first line many inboxes show after the subject. */
  preheader: string;
  /** Small line above the block, usually who it is from. */
  from: string;
  tone: EmailTone;
  /** Inside the colour block. */
  kicker: string;
  amount?: string;
  headline: string;
  paragraphs?: string[];
  rows?: EmailRow[];
  rowsTitle?: string;
  button?: { label: string; url: string };
  note?: { title: string; text: string };
  footer: string;
}

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const b = BLOCK[c.tone];
  const rows = (c.rows ?? [])
    .map(
      (r) => `<tr>
  <td style="padding:14px 0;border-top:1px solid ${C.line};font:500 15px/1.4 ${BODY};color:${C.ink};">${esc(r.label)}${r.sub ? `<div style="font:400 13px/1.4 ${BODY};color:${C.ink3};margin-top:2px;">${esc(r.sub)}</div>` : ""}</td>
  <td align="right" style="padding:14px 0;border-top:1px solid ${C.line};font:700 15px/1.4 ${BODY};color:${r.tone === "in" ? C.in : r.tone === "out" ? C.out : C.ink};white-space:nowrap;">${esc(r.value)}</td>
</tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(c.headline)}</title></head>
<body style="margin:0;padding:0;background:${C.canvas};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.canvas};">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas};">
<tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding:0 4px 14px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="background:${C.ink};border-radius:10px;width:30px;height:22px;"><div style="width:14px;height:8px;background:#eac119;border-radius:4px;margin:4px 0 0 4px;"></div></td>
      <td style="padding-left:9px;font:800 20px/1 ${DISPLAY};letter-spacing:-0.03em;color:${C.ink};">lekha</td>
      <td style="padding-left:12px;font:400 13px/1 ${BODY};color:${C.ink3};">${esc(c.from)}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${b.bg};border-radius:28px;padding:30px 28px;">
    <div style="font:600 14px/1.3 ${BODY};color:${b.sub};">${esc(c.kicker)}</div>
    ${c.amount ? `<div style="font:800 46px/1.05 ${DISPLAY};letter-spacing:-0.035em;color:${b.fg};margin-top:10px;">${esc(c.amount)}</div>` : ""}
    <div style="font:800 ${c.amount ? "20px/1.25" : "30px/1.1"} ${DISPLAY};letter-spacing:-0.02em;color:${b.fg};margin-top:${c.amount ? "8px" : "10px"};">${esc(c.headline)}</div>
  </td></tr>
  <tr><td style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr>
  <tr><td style="background:${C.surface};border-radius:28px;padding:24px 28px;border:1px solid ${C.line};">
    ${(c.paragraphs ?? []).map((p) => `<p style="margin:0 0 14px;font:400 16px/1.55 ${BODY};color:${C.ink2};">${esc(p)}</p>`).join("")}
    ${c.note ? `<div style="background:${C.canvas};border-radius:18px;padding:14px 16px;margin:4px 0 16px;"><div style="font:600 13px/1.3 ${BODY};color:${C.ink3};">${esc(c.note.title)}</div><div style="font:400 15px/1.5 ${BODY};color:${C.ink};margin-top:4px;white-space:pre-wrap;">${esc(c.note.text)}</div></div>` : ""}
    ${rows ? `${c.rowsTitle ? `<div style="font:700 13px/1.3 ${BODY};text-transform:uppercase;letter-spacing:0.06em;color:${C.ink3};margin:6px 0 4px;">${esc(c.rowsTitle)}</div>` : ""}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>` : ""}
    ${c.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px;"><tr><td style="background:${C.ink};border-radius:999px;"><a href="${esc(c.button.url)}" style="display:inline-block;padding:15px 26px;font:600 16px/1 ${BODY};color:${C.surface};text-decoration:none;">${esc(c.button.label)}</a></td></tr></table>` : ""}
  </td></tr>
  <tr><td style="padding:18px 8px 0;font:400 12px/1.6 ${BODY};color:${C.ink3};">${esc(c.footer)}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = [
    c.from,
    "",
    c.kicker,
    c.amount ?? "",
    c.headline,
    "",
    ...(c.paragraphs ?? []),
    c.note ? `${c.note.title}: ${c.note.text}` : "",
    ...(c.rows ?? []).map((r) => `${r.label}${r.sub ? ` (${r.sub})` : ""}: ${r.value}`),
    c.button ? `\n${c.button.label}: ${c.button.url}` : "",
    "",
    c.footer,
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n")
    .trim();

  return { html, text };
}
