import "server-only";
import { cache } from "react";
import { anonDb } from "@/lib/supabase/server";
import { buildStatement, type Perspective } from "@/lib/domain/ledger";
import { participantBalances, simplifyDebts } from "@/lib/domain/split";
import { formatINR, sum, toPaise } from "@/lib/domain/money";
import { formatDateShort, todayISO } from "@/lib/domain/dates";
import { isTokenShape, loadShared, sharedPersonalRecords, type SharedPayload } from "./shared";

/** Sender and look of a share link (public.get_share_card). Null if the link is not active. */
export const loadShareCard = cache(async (token: string) => {
  if (!isTokenShape(token)) return null;
  const { data, error } = await anonDb().rpc("get_share_card", { p_token: token });
  if (error || !data) return null;
  return data as { color: string | null; shared_by: string | null; business: string | null };
});

/** One fetch per request for the page, its metadata and its preview image. */
export const loadSharedOnce = cache(loadShared);

const TYPE_COLOR = { basic: "mustard", taxation: "lavender", personal: "pink" } as const;
const TYPE_LABEL = { basic: "Ledger statement", taxation: "Tax ledger statement", personal: "Shared account" } as const;

export interface ShareSummary {
  ledgerName: string;
  typeLabel: string;
  color: string;
  sharedBy: string | null;
  business: string | null;
  party: string | null;
  /** Big line on the card, e.g. "Ramesh Saini owes Vishwa". */
  headline: string;
  /** Formatted amount for the headline, or null when balances are hidden. */
  amount: string | null;
  chips: string[];
  /** One sentence for link previews that show text only. */
  description: string;
}

/**
 * What a share link says about itself, written for the person receiving it. "You" on the owner's
 * screens becomes the sender's name here, so the preview reads correctly in the recipient's chat.
 */
export function summarizeShare(shared: SharedPayload, card: Awaited<ReturnType<typeof loadShareCard>>): ShareSummary {
  const { ledger, options } = shared;
  const sender = card?.shared_by?.trim() || null;
  const senderName = sender?.split(/\s+/)[0] ?? "the sender";
  const updated = `Updated ${formatDateShort(ledger.last_activity_at, todayISO())}`;
  const base = {
    ledgerName: ledger.name,
    typeLabel: TYPE_LABEL[ledger.ledger_type],
    color: card?.color ?? TYPE_COLOR[ledger.ledger_type],
    sharedBy: sender,
    business: card?.business?.trim() || null,
    party: ledger.contractor_name,
  };

  if (ledger.ledger_type === "personal") {
    const records = sharedPersonalRecords(shared);
    const ids = records.participants.map((p) => p.id);
    const debts = simplifyDebts(participantBalances(ids, records.expenses, records.settlements), ids);
    const name = (id: string) => records.participants.find((p) => p.id === id)?.name ?? "";
    const spent = sum(records.expenses.map((e) => toPaise(e.total_amount)));
    const top = debts[0];
    const headline = top ? `${name(top.from)} owes ${name(top.to)}` : "All settled";
    const amount = top ? formatINR(top.amount) : null;
    const chips = [`${records.participants.length} people`, `${formatINR(spent)} spent`, updated];
    return {
      ...base,
      headline,
      amount,
      chips,
      description: `${top ? `${headline} ${amount}. ` : "Everyone is settled. "}${records.participants.length} people, ${formatINR(spent)} spent. Live, updates as expenses are added.`,
    };
  }

  const perspective = ledger.perspective as Perspective;
  const s = buildStatement({ perspective, opening_balance: ledger.opening_balance ?? "0" }, shared.transactions);
  const party = ledger.contractor_name?.trim() || "The party";
  let headline: string;
  if (perspective === "cashbook") headline = s.closing < 0n ? "Overspent" : "Balance";
  else if (s.closing === 0n) headline = "Settled";
  else headline = s.closing > 0n ? `${party} owes ${senderName}` : `${sender ? senderName : "The sender"} owes ${party}`;
  const amount = options.show_balance && s.closing !== 0n ? formatINR(s.closing < 0n && perspective === "party" ? -s.closing : s.closing) : null;
  const count = shared.transactions.length;
  const chips = [`${count} ${count === 1 ? "entry" : "entries"}`, updated];
  return {
    ...base,
    headline: options.show_balance ? headline : `${count} ${count === 1 ? "entry" : "entries"}`,
    amount,
    chips: options.show_balance ? chips : [updated],
    description: `${options.show_balance ? `${headline}${amount ? ` ${amount}` : ""}. ` : ""}${count} entries${ledger.contractor_name ? ` with ${ledger.contractor_name}` : ""}. Live statement, updates as entries are added.`,
  };
}

/** The prefilled WhatsApp message: greets the person, states the figure they will see, signs off. */
export function shareMessage(s: ShareSummary, url: string, personal: boolean) {
  const first = (name: string | null) => name?.trim().split(/\s+/)[0] ?? "";
  const greet = personal ? "Hi all," : s.party ? `Hi ${first(s.party)},` : "Hi,";
  const figure = s.amount ? `${s.headline}: *${s.amount}*` : s.headline;
  return [
    greet,
    "",
    `Here’s the live statement for *${s.ledgerName}*${s.business ? ` from ${s.business}` : ""}.`,
    figure,
    "",
    "It updates on its own whenever an entry is added, so this one link always shows the latest.",
    url,
    ...(s.sharedBy ? ["", `– ${s.sharedBy}`] : []),
  ].join("\n");
}

export { whatsappNumber } from "@/lib/whatsapp";
