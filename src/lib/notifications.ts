import { formatINR, toPaise } from "@/lib/domain/money";

/** A notification as stored (public.notifications). */
export interface NotificationRow {
  id: number;
  kind: "entry" | "expense" | "payment" | "confirmed" | "invoice_viewed" | "invoice_claim" | "joined" | "invoice_overdue" | "advance_due";
  actor_name: string | null;
  subject: string | null;
  amount: string | number | null;
  direction: "in" | "out" | null;
  detail: string | null;
  href: string | null;
  created_at: string;
  read_at: string | null;
}

const money = (v: NotificationRow["amount"]) => (v === null || v === undefined ? "" : formatINR(toPaise(String(v))));

/** The sentence shown for a notification, written for the person reading it. */
export function describeNotification(n: NotificationRow): { title: string; body: string | null; tone: "in" | "out" | "neutral" | "warn" } {
  const who = n.actor_name?.trim() || "Someone";
  const subject = n.subject ?? "";
  switch (n.kind) {
    case "entry":
      return {
        title: `${who} added ${money(n.amount)} ${n.direction === "in" ? "money in" : "money out"}`,
        body: [subject, n.detail].filter(Boolean).join(" · ") || null,
        tone: n.direction === "in" ? "in" : "out",
      };
    case "expense":
      return { title: `${who} added an expense of ${money(n.amount)}`, body: [n.detail, subject].filter(Boolean).join(" · ") || null, tone: "neutral" };
    case "payment":
      return { title: `${who} recorded a payment of ${money(n.amount)}`, body: [n.detail, subject].filter(Boolean).join(" · ") || null, tone: "in" };
    case "confirmed":
      return { title: `${who} confirmed the statement`, body: subject || null, tone: "in" };
    case "invoice_viewed":
      return { title: `${who} opened ${subject}`, body: null, tone: "neutral" };
    case "invoice_claim":
      return { title: `${who} says they paid ${money(n.amount)}`, body: `${subject} · check it against your account`, tone: "in" };
    case "joined":
      return { title: `${who} joined Lekha`, body: `${n.detail ?? ""} · tap to link your client ${subject}`.trim(), tone: "in" };
    case "invoice_overdue":
      return { title: `${subject} is overdue`, body: [who !== "Someone" ? who : null, `${money(n.amount)} due`, n.detail].filter(Boolean).join(" · "), tone: "warn" };
    case "advance_due":
      return { title: `Advance${who !== "Someone" ? ` to ${who}` : ""} is due back`, body: [money(n.amount), n.detail].filter(Boolean).join(" · "), tone: "warn" };
    default:
      return { title: "Update", body: null, tone: "neutral" };
  }
}
