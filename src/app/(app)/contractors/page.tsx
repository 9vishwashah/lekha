import Link from "next/link";
import { getWorkspace } from "@/lib/server/context";
import { listContractors } from "@/lib/server/queries";
import { advancesWithPositions, ledgerBalances } from "@/lib/server/workspace-data";
import { loadSharedAccountRows, net, peoplePositions } from "@/lib/server/people";
import { Avatar, Badge, EmptyState, PageHeader } from "@/components/ui/bits";
import { Money } from "@/components/ui/amount";
import { AddContractorButton } from "./add-button";
import { todayISO } from "@/lib/domain/dates";
import { cn } from "@/lib/cn";

export const metadata = { title: "Client Accounts" };

const FILTERS = [
  { key: "all", label: "Everyone" },
  { key: "business", label: "Clients" },
  { key: "personal", label: "Friends & family" },
  { key: "inactive", label: "Inactive" },
];

export default async function ContractorsPage(props: PageProps<"/contractors">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const show = FILTERS.some((f) => f.key === params.show) ? params.show : "all";
  const q = (params.q ?? "").trim().toLowerCase();
  const [contractors, balances, advances, sharedRows] = await Promise.all([
    listContractors(ctx.db, ctx.workspace.id),
    ledgerBalances(ctx.db, ctx.workspace.id),
    advancesWithPositions(ctx.db, ctx.workspace.id, todayISO()),
    loadSharedAccountRows(ctx.db),
  ]);
  const people = peoplePositions(ctx.workspace.id, ctx.userId, balances, sharedRows);
  const visible = contractors
    .filter((c) => (show === "inactive" ? !c.is_active : c.is_active && (show === "all" || c.kind === show)))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.business_name?.toLowerCase().includes(q) || c.phone?.includes(q))
    .sort((a, b) => {
      // From Home: "People owe you" lists the biggest debts first, "You owe people" likewise.
      if (params.sort === "owes" || params.sort === "owe") {
        const na = net(people.byClient.get(a.id));
        const nb = net(people.byClient.get(b.id));
        return params.sort === "owes" ? (nb > na ? 1 : nb < na ? -1 : 0) : na > nb ? 1 : na < nb ? -1 : 0;
      }
      return a.name.localeCompare(b.name);
    });
  const qs = (extra: Record<string, string>) => `/contractors?${new URLSearchParams({ ...(params.q && { q: params.q }), ...extra })}`;

  return (
    <div>
      <PageHeader
        title="Client Accounts"
        kicker={`${contractors.filter((c) => c.is_active).length} active · clients, contractors, friends & family`}
        actions={ctx.canWrite && <AddContractorButton existing={contractors.map((c) => ({ id: c.id, name: c.name, phone: c.phone }))} />}
      />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <form action="/contractors" className="w-full sm:max-w-sm">
          {show !== "all" && <input type="hidden" name="show" value={show} />}
          <label htmlFor="cq" className="sr-only">
            Search client accounts
          </label>
          <input
            id="cq"
            name="q"
            defaultValue={params.q}
            placeholder="Search name, business or phone"
            className="h-12 w-full rounded-full bg-surface px-5 text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </form>
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0" aria-label="Show">
          <div className="flex gap-1 rounded-full bg-sunken p-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={qs(f.key === "all" ? {} : { show: f.key })}
                className={cn("inline-flex h-10 items-center whitespace-nowrap rounded-full px-4 text-sm font-medium", show === f.key ? "bg-ink text-surface" : "text-ink-2")}
              >
                {f.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={q ? "No one matches that search" : show === "inactive" ? "No inactive accounts" : "Add your first client"}
          body="Everyone you deal with lives here: clients, contractors, suppliers, friends and family. Link them to ledgers, shared accounts and advances to see what each person owes in one place."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((c) => {
            const ledgers = balances.entries.filter((e) => e.ledger.contractor_id === c.id && e.ledger.status === "active").length;
            const shared = sharedRows.participants.filter((p) => p.contractor_id === c.id).length;
            const adv = advances.filter((a) => a.contractor_id === c.id && a.status === "active").reduce((acc, a) => acc + a.position.outstanding, 0n);
            const balance = net(people.byClient.get(c.id));
            return (
              <li key={c.id}>
                <Link href={`/contractors/${c.id}`} className="flex h-full flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 hover:bg-white">
                  <div className="flex items-center gap-3">
                    <Avatar name={c.name} className="size-12 text-base" tone={c.kind === "personal" ? "sunken" : "ink"} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-lg font-semibold">{c.name}</div>
                      <div className="truncate text-sm text-ink-3">{c.business_name || c.phone || (c.kind === "personal" ? "Friend or family" : "Client")}</div>
                    </div>
                    {balance !== 0n && (
                      <div className="text-right">
                        <Money value={balance > 0n ? balance : -balance} tone={balance > 0n ? "in" : "out"} className="block font-semibold" />
                        <span className="text-[12px] text-ink-3">{balance > 0n ? "owes you" : "you owe"}</span>
                      </div>
                    )}
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-2 text-sm">
                    {ledgers > 0 && <Badge>{ledgers === 1 ? "1 ledger" : `${ledgers} ledgers`}</Badge>}
                    {shared > 0 && <Badge>{shared === 1 ? "1 shared account" : `${shared} shared accounts`}</Badge>}
                    {adv > 0n && (
                      <Badge tone="warn">
                        Advance <Money value={adv} className="font-semibold" />
                      </Badge>
                    )}
                    {c.linked_user_id && <Badge tone="in">On Lekha</Badge>}
                    {c.merged_into && <Badge>Merged</Badge>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
