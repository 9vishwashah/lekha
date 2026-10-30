import { getCollaborations, getMemberships } from "@/lib/server/context";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { WalletCard } from "@/components/app/wallet-card";
import { LinkButton } from "@/components/ui/button";
import { relativeTime } from "@/lib/domain/dates";

export const metadata = { title: "Shared with me" };

export default async function SharedPage() {
  const [shared, memberships] = await Promise.all([getCollaborations(), getMemberships()]);
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
            .map((s) => (
              <li key={s.id}>
                <WalletCard
                  href={`/ledgers/${s.ledger!.id}`}
                  color={s.ledger!.color}
                  name={s.ledger!.name}
                  type={s.ledger!.ledger_type}
                  balance={null}
                  meaning={s.can_create ? "You can add entries" : "View only"}
                  chips={[`Updated ${relativeTime(s.ledger!.last_activity_at)}`]}
                />
              </li>
            ))}
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
