import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { ledgerBalances } from "@/lib/server/workspace-data";
import { getPersonalLedger } from "@/lib/server/queries";
import { describeBalance, type Perspective } from "@/lib/domain/ledger";
import { participantBalances } from "@/lib/domain/split";
import { formatINR } from "@/lib/domain/money";
import { relativeTime } from "@/lib/domain/dates";
import { WalletCard } from "@/components/app/wallet-card";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export const metadata = { title: "Ledgers" };

export default async function LedgersPage(props: PageProps<"/ledgers">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const showArchived = params.status === "archived";
  const q = (params.q ?? "").trim().toLowerCase();
  const picking = params.add === "entry";
  const { entries } = await ledgerBalances(ctx.db, ctx.workspace.id);

  const visible = entries.filter(
    (e) =>
      (showArchived ? e.ledger.status === "archived" : e.ledger.status === "active") &&
      (!q || e.ledger.name.toLowerCase().includes(q) || e.ledger.contractor?.name.toLowerCase().includes(q)),
  );

  // Personal ledgers: show the signed-in owner's own position.
  const personal = await Promise.all(
    visible
      .filter((e) => e.ledger.ledger_type === "personal")
      .map(async (e) => {
        const data = await getPersonalLedger(ctx.db, e.ledger.id);
        const me = data.participants.find((p) => p.user_id === ctx.userId);
        const balances = participantBalances(data.participants.map((p) => p.id), data.expenses, data.settlements);
        return [e.ledger.id, { net: me ? (balances.get(me.id)?.net ?? 0n) : 0n, people: data.participants.length }] as const;
      }),
  );
  const personalMap = new Map(personal);

  return (
    <div>
      <PageHeader
        title="Ledgers"
        kicker={`${ctx.workspace.name}`}
        actions={
          ctx.canWrite && (
            <LinkButton href="/ledgers/new">
              <Plus className="size-5" /> New ledger
            </LinkButton>
          )
        }
      />

      {picking && (
        <div className="mb-6 rounded-3xl bg-ink p-5 text-seashell">
          <div className="display text-2xl font-bold">Which ledger is this entry for?</div>
          <p className="mt-1 text-sm opacity-70">Pick a ledger below. The entry form opens straight away.</p>
        </div>
      )}

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <form action="/ledgers" className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <label htmlFor="ledger-search" className="sr-only">
            Search ledgers
          </label>
          <input
            id="ledger-search"
            name="q"
            defaultValue={params.q}
            placeholder="Search by ledger or contractor"
            className="h-12 w-full rounded-full bg-surface pl-11 pr-4 text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink"
          />
          {showArchived && <input type="hidden" name="status" value="archived" />}
          {picking && <input type="hidden" name="add" value="entry" />}
        </form>
        <nav aria-label="Ledger status" className="flex w-fit gap-1 rounded-full bg-sunken p-1">
          {[
            { label: "Active", href: "/ledgers", on: !showArchived },
            { label: "Archived", href: "/ledgers?status=archived", on: showArchived },
          ].map((t) => (
            <Link
              key={t.label}
              href={t.href}
              className={cn("inline-flex h-10 items-center rounded-full px-4 text-sm font-medium", t.on ? "bg-ink text-surface" : "text-ink-2")}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={q ? "No ledger matches that search" : showArchived ? "Nothing archived" : "No ledgers yet"}
          body={
            q
              ? "Try part of the contractor’s name, or clear the search."
              : showArchived
                ? "Archived ledgers keep their full history and can be restored at any time."
                : "Create a basic ledger for day-to-day money in and out, a taxation ledger for GST and TDS bills, or a shared account to split costs."
          }
          action={!q && !showArchived && ctx.canWrite ? <LinkButton href="/ledgers/new">Create a ledger</LinkButton> : undefined}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((e, i) => {
            const l = e.ledger;
            const p = personalMap.get(l.id);
            const balance = l.ledger_type === "personal" ? (p?.net ?? 0n) : (e.statement?.closing ?? 0n);
            const meaning =
              l.ledger_type === "personal"
                ? balance === 0n
                  ? "All settled"
                  : balance > 0n
                    ? "Owed to you overall"
                    : "You owe overall"
                : describeBalance(l.perspective as Perspective, e.statement?.closing ?? 0n, l.contractor?.name).label +
                  (l.perspective === "cashbook" && balance < 0n ? ` (${formatINR(balance)})` : "");
            return (
              <li key={l.id} className="animate-rise" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                <WalletCard
                  href={picking ? `/ledgers/${l.id}?add=1` : `/ledgers/${l.id}`}
                  color={l.color}
                  name={l.name}
                  subtitle={l.contractor?.name}
                  type={l.ledger_type}
                  balance={balance}
                  meaning={meaning}
                  archived={l.status === "archived"}
                  chips={[
                    l.ledger_type === "personal" ? `${p?.people ?? 0} people` : `${e.count} entries`,
                    `Updated ${relativeTime(l.last_activity_at)}`,
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
