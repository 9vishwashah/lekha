import { getCollaborations, getMemberships, requireUser } from "@/lib/server/context";
import { loadSharedAccountRows, sharedAccountDebts } from "@/lib/server/people";
import { userDb } from "@/lib/supabase/server";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { WalletCard } from "@/components/app/wallet-card";
import { LinkButton } from "@/components/ui/button";
import { relativeTime } from "@/lib/domain/dates";

export const metadata = { title: "Shared with me" };

export default async function SharedPage() {
  const [shared, memberships, userId, db] = await Promise.all([getCollaborations(), getMemberships(), requireUser(), userDb()]);
  const accounts = new Map(sharedAccountDebts(await loadSharedAccountRows(db), userId).map((a) => [a.ledger.id, a]));
  const position = (ledgerId: string, canCreate: boolean) => {
    const account = accounts.get(ledgerId);
    if (!account) return { balance: null, meaning: canCreate ? "You can add entries" : "View only", name: null };
    const net = account.lines.reduce((total, line) => total + line.amount, 0n);
    const other = account.lines.length === 1 ? account.lines[0].other.display_name.split(" ")[0] : null;
    return {
      balance: net,
      meaning: net === 0n ? "All settled" : net > 0n ? (other ? `${other} owes you` : "You are owed") : other ? `You owe ${other}` : "You owe",
      name: account.ledger.is_direct ? (account.owner?.display_name ?? null) : null,
    };
  };
  return (
    <div>
      <PageHeader title="Shared with me">
        <p className="mt-3 max-w-2xl text-ink-2">Ledgers other people invited you to. You see only these ledgers, never the rest of their workspace.</p>
      </PageHeader>
      {shared.length === 0 ? (
        <EmptyState
          title="Nothing shared with you yet"
          body="When someone invites you to a ledger, it shows up here."
          action={memberships.length === 0 ? <LinkButton href="/onboarding">Create your own workspace</LinkButton> : undefined}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shared
            .filter((s) => s.ledger)
            .map((s) => {
              const p = position(s.ledger!.id, s.can_create);
              return (
                <li key={s.id}>
                  <WalletCard
                    href={`/ledgers/${s.ledger!.id}`}
                    color={s.ledger!.color}
                    name={p.name ?? s.ledger!.name}
                    type={s.ledger!.ledger_type}
                    balance={p.balance}
                    meaning={p.meaning}
                    chips={[`Updated ${relativeTime(s.ledger!.last_activity_at)}`]}
                  />
                </li>
              );
            })}
        </ul>
      )}
      {memberships.length === 0 && shared.length > 0 && (
        <div className="mt-10">
          <LinkButton href="/onboarding" variant="secondary">
            Start your own workspace
          </LinkButton>
        </div>
      )}
    </div>
  );
}
