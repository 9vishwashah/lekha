import { IntentLink } from "@/components/app/intent-link";
import { FilterChips } from "@/components/app/pending-nav";
import { loadPeople } from "@/lib/server/profiles";
import { listInvoices } from "@/lib/server/invoices";
import { getWorkspace } from "@/lib/server/context";
import { listContractors } from "@/lib/server/queries";
import { advancesWithPositions, ledgerBalances } from "@/lib/server/workspace-data";
import { externalNet, loadSharedAccountRows, peoplePositions } from "@/lib/server/people";
import { loadBooks } from "@/lib/server/books";
import { Avatar, Badge, EmptyState, PageHeader } from "@/components/ui/bits";
import { Money } from "@/components/ui/amount";
import { AddContractorButton } from "./add-button";
import { todayISO } from "@/lib/domain/dates";

export const metadata = { title: "Client Accounts" };

const FILTERS = [
  { key: "all", label: "Everyone" },
  { key: "owes", label: "Owe you · debtors" },
  { key: "owe", label: "You owe · creditors" },
  { key: "business", label: "Clients" },
  { key: "personal", label: "Friends & family" },
  { key: "inactive", label: "Inactive" },
];

export default async function ContractorsPage(props: PageProps<"/contractors">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  // Home's "People owe you" and "You owe people" open these lists. Older links used ?sort=.
  const alias: Record<string, string> = { debtors: "owes", creditors: "owe" };
  const wanted = alias[params.show ?? ""] ?? params.show ?? params.sort;
  const show = FILTERS.some((f) => f.key === wanted) ? wanted : "all";
  const q = (params.q ?? "").trim().toLowerCase();
  const [contractors, balances, advances, sharedRows, invoices] = await Promise.all([
    listContractors(ctx.db, ctx.workspace.id),
    ledgerBalances(ctx.db, ctx.workspace.id),
    advancesWithPositions(ctx.db, ctx.workspace.id, todayISO()),
    loadSharedAccountRows(ctx.db),
    listInvoices(ctx.db, ctx.workspace.id),
  ]);
  const people = peoplePositions(ctx.workspace.id, ctx.userId, balances, sharedRows, invoices, contractors);
  const [accounts, books] = await Promise.all([loadPeople(ctx.db, contractors.map((c) => c.linked_user_id)), loadBooks(ctx.db, ctx.workspace.id, sharedRows)]);
  // The same figure Home adds up, so the two always agree to the rupee.
  const balanceOf = (id: string) => books.positions.get(id) ?? 0n;
  const owing = show === "owes" || show === "owe";
  const visible = contractors
    .filter((c) =>
      show === "inactive" ? !c.is_active : show === "owes" ? balanceOf(c.id) > 0n : show === "owe" ? balanceOf(c.id) < 0n : c.is_active && (show === "all" || c.kind === show),
    )
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.business_name?.toLowerCase().includes(q) || c.phone?.includes(q))
    .sort((a, b) => {
      if (owing) {
        const na = balanceOf(a.id);
        const nb = balanceOf(b.id);
        return show === "owes" ? (nb > na ? 1 : nb < na ? -1 : 0) : na > nb ? 1 : na < nb ? -1 : 0;
      }
      return a.name.localeCompare(b.name);
    });
  // Debts with no client record to show them on, such as an invoice made out to a typed name.
  const known = new Set(contractors.map((c) => c.id));
  const unnamed = [...books.positions].filter(([k, v]) => !known.has(k) && (show === "owes" ? v > 0n : show === "owe" ? v < 0n : false));
  const listTotal = visible.reduce((t, c) => t + balanceOf(c.id), 0n) + unnamed.reduce((t, [, v]) => t + v, 0n);
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
        <FilterChips
          label="Show"
          active={show}
          items={FILTERS.map((f) => ({ key: f.key, href: qs(f.key === "all" ? {} : { show: f.key }), label: f.label }))}
        />
      </div>

      {owing && (
        <p className="mb-4 text-[15px] text-ink-2">
          {show === "owes" ? "Sundry debtors" : "Sundry creditors"}: <Money value={listTotal < 0n ? -listTotal : listTotal} className="font-semibold text-ink" />, the same figure as on Home.
          {unnamed.length > 0 && ` Includes ${unnamed.length} without a client record, listed in Books.`}
        </p>
      )}
      {visible.length === 0 ? (
        <EmptyState
          title={q ? "No one matches that search" : show === "inactive" ? "No inactive accounts" : show === "owes" ? "No one owes you" : show === "owe" ? "You owe no one" : "Add your first client"}
          body="Everyone you deal with lives here: clients, contractors, suppliers, friends and family. Link them to ledgers, shared accounts and advances to see what each person owes in one place."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((c) => {
            const ledgers = balances.entries.filter((e) => e.ledger.contractor_id === c.id && e.ledger.ledger_type !== "personal" && !e.ledger.is_direct).length;
            const shared = sharedRows.participants.filter((p) => p.contractor_id === c.id).length;
            const adv = advances.filter((a) => a.contractor_id === c.id && a.status === "active").reduce((acc, a) => acc + a.position.outstanding, 0n);
            const balance = balanceOf(c.id);
            const theirs = externalNet(people.byClient.get(c.id));
            return (
              <li key={c.id}>
                <IntentLink href={`/contractors/${c.id}`} className="flex h-full flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 hover:bg-white">
                  <div className="flex items-center gap-3">
                    <Avatar
                      name={c.name}
                      src={c.linked_user_id ? accounts.get(c.linked_user_id)?.photo : null}
                      className="size-12 text-base"
                      tone={c.kind === "personal" ? "sunken" : "ink"}
                    />
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
                    {c.linked_user_id && (
                      <Badge tone="in">{accounts.get(c.linked_user_id)?.username ? `@${accounts.get(c.linked_user_id)!.username}` : "On Lekha"}</Badge>
                    )}
                    {c.merged_into && <Badge>Merged</Badge>}
                    {theirs !== 0n && (
                      <span className="text-[12px] text-ink-3">
                        In their accounts: {theirs > 0n ? "they owe you" : "you owe"} <Money value={theirs > 0n ? theirs : -theirs} />
                      </span>
                    )}
                  </div>
                </IntentLink>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
