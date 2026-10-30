import type { getPersonalLedger } from "@/lib/server/queries";
import type { LedgerAccess } from "@/lib/server/access";
import { participantBalances, simplifyDebts } from "@/lib/domain/split";
import { toDecimal } from "@/lib/domain/money";
import type { Ledger } from "@/lib/types";
import { PersonalScreen } from "./personal-screen";
import { userDb } from "@/lib/supabase/server";
import { loadPeople } from "@/lib/server/profiles";

/**
 * Server half of a shared account: loads the one canonical set of expenses and repayments and
 * works out every person's position. The client half only presents it from the viewer's side.
 */
export async function PersonalLedger({
  ledger,
  access,
  userId,
  today,
  openAdd,
  data,
  names,
}: {
  ledger: Ledger & { contractor: unknown };
  access: LedgerAccess;
  userId: string;
  today: string;
  openAdd: boolean;
  data: Awaited<ReturnType<typeof getPersonalLedger>>;
  names: Map<string, string>;
}) {
  const ids = data.participants.map((p) => p.id);
  const balances = participantBalances(ids, data.expenses, data.settlements);
  const debts = simplifyDebts(balances, ids);
  const viewer = data.participants.find((p) => p.user_id === userId) ?? null;
  // Profile photos of everyone in the account who is on Lekha.
  const accounts = await loadPeople(await userDb(), data.participants.map((p) => p.user_id));

  return (
    <PersonalScreen
      ledger={{ id: ledger.id, name: ledger.name, color: ledger.color, status: ledger.status, lastActivity: ledger.last_activity_at }}
      participants={data.participants.map((p) => {
        const b = balances.get(p.id)!;
        return {
          id: p.id,
          name: p.display_name,
          linked: Boolean(p.user_id),
          photo: p.user_id ? (accounts.get(p.user_id)?.photo ?? null) : null,
          isViewer: p.id === viewer?.id,
          paid: toDecimal(b.paid),
          share: toDecimal(b.share),
          net: toDecimal(b.net),
        };
      })}
      debts={debts.map((d) => ({ from: d.from, to: d.to, amount: toDecimal(d.amount) }))}
      expenses={data.expenses}
      settlements={data.settlements}
      viewerId={viewer?.id ?? null}
      userId={userId}
      access={access}
      names={Object.fromEntries(names)}
      today={today}
      openAdd={openAdd}
    />
  );
}
