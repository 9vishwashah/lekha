import { renderEmail } from "./theme";
import { describeNotification, type NotificationRow } from "@/lib/notifications";
import { formatINR, toPaise, type Paise } from "@/lib/domain/money";
import { formatDateShort } from "@/lib/domain/dates";

export interface Email {
  subject: string;
  html: string;
  text: string;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || "there";
const rupees = (p: Paise) => formatINR(p < 0n ? -p : p);
const monthName = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

/** 1. Payment reminder to a client, sent from their page. Only for money they owe. */
export function paymentReminderEmail(p: { business: string; sender: string; clientName: string; balance: Paise; note?: string | null; statementUrl?: string | null }): Email {
  const amount = rupees(p.balance);
  const { html, text } = renderEmail({
    preheader: `${amount} is pending to ${p.business}.`,
    from: `from ${p.business}`,
    tone: "mustard",
    kicker: `Payment reminder from ${p.business}`,
    amount,
    headline: "is pending from you",
    paragraphs: [
      `Hi ${first(p.clientName)},`,
      `This is a friendly reminder that ${amount} is outstanding on your account with ${p.business}. If you have already paid, thank you, and please ignore this note.`,
    ],
    note: p.note?.trim() ? { title: `Message from ${p.sender}`, text: p.note.trim() } : undefined,
    button: p.statementUrl ? { label: "View your statement", url: p.statementUrl } : undefined,
    footer: `Sent by ${p.sender} from ${p.business} using Lekha. Reply to this email to reach them directly.`,
  });
  return { subject: `Reminder: ${amount} pending to ${p.business}`, html, text };
}

/** 2. New activity: what other people added with you since the last email. */
export function activityDigestEmail(p: { name: string | null; items: NotificationRow[]; appUrl: string }): Email {
  const n = p.items.length;
  const rows = p.items.slice(0, 25).map((item) => {
    const d = describeNotification(item);
    return { label: d.title, value: "", sub: [d.body, formatDateShort(item.created_at.slice(0, 10))].filter(Boolean).join(" · ") };
  });
  const { html, text } = renderEmail({
    preheader: rows[0]?.label ?? "New activity on Lekha",
    from: "Your accounts",
    tone: "sky",
    kicker: "New activity",
    headline: n === 1 ? "1 new update with you" : `${n} new updates with you`,
    paragraphs: [`Hi ${first(p.name ?? "")}, here is what people added or changed with you on Lekha.`],
    rows,
    rowsTitle: n > 25 ? `Latest 25 of ${n}` : undefined,
    button: { label: "Open Lekha", url: `${p.appUrl}/notifications` },
    footer: "You get this because new-activity emails are on. Turn them off in Lekha under Settings → Email.",
  });
  return { subject: n === 1 ? rows[0].label : `${n} new updates on Lekha`, html, text };
}

/** 3. Monthly statement to a client who has it turned on. */
export function monthlyStatementEmail(p: { business: string; ownerName: string | null; clientName: string; balance: Paise; month: string; statementUrl?: string | null }): Email {
  const owes = p.balance > 0n;
  const amount = rupees(p.balance);
  const { html, text } = renderEmail({
    preheader: owes ? `Balance due: ${amount}` : `${p.business} owes you ${amount}`,
    from: `from ${p.business}`,
    tone: "tea",
    kicker: `${monthName(p.month)} statement · ${p.business}`,
    amount,
    headline: owes ? `you owe ${p.business}` : `${p.business} owes you`,
    paragraphs: [
      `Hi ${first(p.clientName)},`,
      owes
        ? `Here is your balance with ${p.business} at the start of the month. Your full statement, with every entry, is one tap away.`
        : `Here is your balance with ${p.business} at the start of the month. They owe you this amount.`,
    ],
    button: p.statementUrl ? { label: "View full statement", url: p.statementUrl } : undefined,
    footer: `Monthly statement from ${p.business}${p.ownerName ? ` (${p.ownerName})` : ""}, sent with Lekha. Reply to this email to reach them.`,
  });
  return { subject: `${monthName(p.month)} statement from ${p.business}: ${owes ? `${amount} due` : `${amount} owed to you`}`, html, text };
}

/** 4. Monthly summary to the owner of a workspace. */
export function monthlySummaryEmail(p: { name: string | null; workspace: string; month: string; owedToYou: Paise; youOwe: Paise; top: { name: string; balance: Paise }[]; appUrl: string }): Email {
  const { html, text } = renderEmail({
    preheader: `People owe you ${rupees(p.owedToYou)} · you owe ${rupees(p.youOwe)}`,
    from: p.workspace,
    tone: "ink",
    kicker: `${monthName(p.month)} summary · ${p.workspace}`,
    amount: rupees(p.owedToYou),
    headline: "owed to you across your clients",
    paragraphs: [`Hi ${first(p.name ?? "")}, here is where things stand at the start of the month.`],
    rowsTitle: "Balances",
    rows: [
      { label: "People owe you", value: rupees(p.owedToYou), tone: "in" as const },
      { label: "You owe people", value: rupees(p.youOwe), tone: "out" as const },
      ...p.top.map((t) => ({ label: t.name, value: rupees(t.balance), sub: t.balance > 0n ? "owes you" : "you owe", tone: t.balance > 0n ? ("in" as const) : ("out" as const) })),
    ],
    button: { label: "Open Lekha", url: `${p.appUrl}/contractors?show=owes` },
    footer: "Monthly summary from Lekha. Turn it off under Settings → Email.",
  });
  return { subject: `${monthName(p.month)}: ${rupees(p.owedToYou)} owed to you · ${p.workspace}`, html, text };
}

/** 5. An invoice sent by email, with the link to view, download and pay. */
export function invoiceEmail(p: { business: string; sender: string; clientName: string; invoiceNo: string; total: Paise; balance: Paise; dueDate?: string | null; url: string; proforma?: boolean }): Email {
  const label = p.proforma ? "Proforma invoice" : "Invoice";
  const { html, text } = renderEmail({
    preheader: `${label} ${p.invoiceNo} · ${rupees(p.balance)} due${p.dueDate ? ` by ${formatDateShort(p.dueDate)}` : ""}`,
    from: `from ${p.business}`,
    tone: "lavender",
    kicker: `${label} ${p.invoiceNo} · ${p.business}`,
    amount: rupees(p.balance),
    headline: p.dueDate ? `due by ${formatDateShort(p.dueDate)}` : "amount due",
    paragraphs: [`Hi ${first(p.clientName)},`, `Please find your ${label.toLowerCase()} from ${p.business}. You can view it, download the PDF and pay from the link below.`],
    rows: [
      { label: `${label} no.`, value: p.invoiceNo },
      { label: "Total", value: rupees(p.total) },
      ...(p.balance !== p.total ? [{ label: "Still due", value: rupees(p.balance), tone: "out" as const }] : []),
    ],
    button: { label: "View & pay invoice", url: p.url },
    footer: `Sent by ${p.sender} from ${p.business} using Lekha. Reply to this email to reach them directly.`,
  });
  return { subject: `${label} ${p.invoiceNo} from ${p.business} · ${rupees(p.balance)}`, html, text };
}

export const paise = (v: string | number) => toPaise(String(v));
