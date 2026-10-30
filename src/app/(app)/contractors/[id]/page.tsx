import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, MapPin, Phone, Plus } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { isUuid, listContractors } from "@/lib/server/queries";
import { advancesWithPositions, ledgerBalances } from "@/lib/server/workspace-data";
import { loadSharedAccountRows, net, peoplePositions } from "@/lib/server/people";
import { describeBalance, type Perspective } from "@/lib/domain/ledger";
import { sum, toPaise } from "@/lib/domain/money";
import { formatDateShort, todayISO } from "@/lib/domain/dates";
import { ADVANCE_STATUS_LABEL } from "@/lib/domain/advances";
import { Amount, Money } from "@/components/ui/amount";
import { Avatar, Badge, Card, SectionTitle } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { WalletCard } from "@/components/app/wallet-card";
import { ContractorActions } from "./actions";
import { ConnectCard } from "./connect";
import { whatsappNumber } from "@/lib/server/share-card";
import { loadPeople } from "@/lib/server/profiles";

export default async function ContractorPage(props: PageProps<"/contractors/[id]">) {
  const ctx = await getWorkspace();
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const today = todayISO();
  // One parallel round; this client comes from the same list the merge picker needs.
  const [balances, advances, all, recent, taxIds, sharedRows] = await Promise.all([
    ledgerBalances(ctx.db, ctx.workspace.id),
    advancesWithPositions(ctx.db, ctx.workspace.id, today),
    listContractors(ctx.db, ctx.workspace.id),
    ctx.db
      .from("transactions")
      .select("id, voucher_no, txn_date, direction, amount, description, status, ledger:ledgers!inner(id, name, contractor_id)")
      .eq("workspace_id", ctx.workspace.id)
      .eq("ledger.contractor_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    ctx.canWrite ? ctx.db.rpc("contractor_tax_ids", { p_contractor: id }) : Promise.resolve({ data: null }),
    loadSharedAccountRows(ctx.db),
  ]);
  const c = all.find((x) => x.id === id);
  if (!c) notFound();
  const account = c.linked_user_id ? ((await loadPeople(ctx.db, [c.linked_user_id])).get(c.linked_user_id) ?? null) : null;
  const position = peoplePositions(ctx.workspace.id, ctx.userId, balances, sharedRows).byClient.get(id);
  const overall = net(position);
  const sharedLedgerIds = new Set(sharedRows.participants.filter((p) => p.contractor_id === id).map((p) => p.ledger_id));
  const sharedAccounts = sharedRows.ledgers.filter((l) => sharedLedgerIds.has(l.id));
  const ledgers = balances.entries.filter((e) => e.ledger.contractor_id === id);
  const mine = advances.filter((a) => a.contractor_id === id);
  const active = mine.filter((a) => a.status === "active");
  const given = sum(active.map((a) => a.position.amount));
  const recovered = sum(active.map((a) => a.position.recovered));
  const adjusted = sum(active.map((a) => a.position.adjusted));
  const outstanding = sum(active.map((a) => a.position.outstanding));
  const overdue = active.filter((a) => a.position.overdue);
  const moneyIn = sum(ledgers.map((e) => e.statement?.totals.moneyIn ?? 0n));
  const moneyOut = sum(ledgers.map((e) => e.statement?.totals.moneyOut ?? 0n));
  const recentRows = (recent.data ?? []) as unknown as { id: string; voucher_no: string; txn_date: string; direction: "in" | "out"; amount: string; description: string | null; status: string; ledger: { id: string; name: string } }[];

  return (
    <div className="flex flex-col gap-8">
      <Link href="/contractors" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Client Accounts
      </Link>

      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-4">
          <Avatar name={c.name} src={account?.photo} tone="ink" className="size-16 text-xl" />
          <div className="min-w-0">
            <h1 className="display text-[2.4rem] font-extrabold sm:text-6xl">{c.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-ink-2">
              {c.business_name && <span>{c.business_name}</span>}
              {!c.is_active && <Badge>Inactive</Badge>}
              {c.merged_into && <Badge>Merged into another contractor</Badge>}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <span className="text-sm font-semibold text-ink-2">{overall === 0n ? "All square" : overall > 0n ? `${c.name.split(" ")[0]} owes you` : `You owe ${c.name.split(" ")[0]}`}</span>
          <Amount value={overall > 0n ? overall : -overall} size="xl" tone={overall > 0n ? "in" : overall < 0n ? "out" : "inherit"} />
          <span className="text-[13px] text-ink-3">Across ledgers and shared accounts</span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {ctx.canWrite && (
          <ContractorActions
            contractor={c}
            taxIds={c.kind === "business" ? ((taxIds.data as { gstin: string | null; pan: string | null } | null) ?? null) : null}
            others={all.filter((x) => x.id !== c.id && x.is_active).map((x) => ({ id: x.id, name: x.name, phone: x.phone }))}
            canMerge={ctx.isAdmin}
          />
        )}
        {ctx.canWrite && (
          <LinkButton href={`/ledgers/new?type=personal&people=${c.id}`} variant="secondary">
            <Plus className="size-4" /> Shared account
          </LinkButton>
        )}
      </div>

      <ConnectCard
        contractor={{ id: c.id, name: c.name }}
        account={account ?? (c.linked_user_id ? { username: null, fullName: c.name, photo: null } : null)}
        canWrite={ctx.canWrite && c.is_active}
        whatsappTo={whatsappNumber(c.phone)}
      />

      <div className="flex flex-wrap gap-2 text-[15px]">
        {c.phone && (
          <a href={`tel:${c.phone}`} className="inline-flex h-11 items-center gap-2 rounded-full bg-surface px-4 ring-1 ring-inset ring-line">
            <Phone className="size-4" /> {c.phone}
          </a>
        )}
        {c.email && (
          <a href={`mailto:${c.email}`} className="inline-flex h-11 items-center gap-2 rounded-full bg-surface px-4 ring-1 ring-inset ring-line">
            <Mail className="size-4" /> {c.email}
          </a>
        )}
        {c.address && (
          <span className="inline-flex min-h-11 items-center gap-2 rounded-full bg-surface px-4 ring-1 ring-inset ring-line">
            <MapPin className="size-4" /> {c.address}
          </span>
        )}
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Totals">
        <div className="rounded-[var(--radius-card)] bg-tea p-5 text-seashell">
          <div className="text-sm font-medium opacity-75">Money in</div>
          <Amount value={moneyIn} size="lg" className="mt-4 block text-[1.6rem] sm:text-[2.2rem]" />
        </div>
        <div className="rounded-[var(--radius-card)] bg-ink p-5 text-seashell">
          <div className="text-sm font-medium opacity-75">Money out</div>
          <Amount value={moneyOut} size="lg" className="mt-4 block text-[1.6rem] sm:text-[2.2rem]" />
        </div>
        <div className="rounded-[var(--radius-card)] bg-pink p-5">
          <div className="text-sm font-semibold">Advance outstanding</div>
          <Amount value={outstanding} size="lg" className="mt-4 block text-[1.6rem] sm:text-[2.2rem]" />
          {overdue.length > 0 && <div className="mt-1 text-[13px] font-semibold text-out">{overdue.length} overdue</div>}
        </div>
        <div className="rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line">
          <div className="text-sm font-semibold">Advances</div>
          <dl className="num mt-3 space-y-1 text-[14px]">
            <div className="flex justify-between"><dt className="text-ink-2">Given</dt><dd><Money value={given} /></dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Recovered</dt><dd><Money value={recovered} /></dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Adjusted</dt><dd><Money value={adjusted} /></dd></div>
          </dl>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle action={ctx.canWrite && <LinkButton href={`/ledgers/new?contractor=${c.id}`} size="sm" variant="secondary"><Plus className="size-4" /> Ledger</LinkButton>}>
          Ledgers
        </SectionTitle>
        {ledgers.length === 0 ? (
          <p className="text-ink-2">No ledgers for {c.name} yet.</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {ledgers.map((e) => (
              <li key={e.ledger.id}>
                <WalletCard
                  href={`/ledgers/${e.ledger.id}`}
                  color={e.ledger.color}
                  name={e.ledger.name}
                  type={e.ledger.ledger_type}
                  balance={e.statement?.closing ?? 0n}
                  meaning={describeBalance(e.ledger.perspective as Perspective, e.statement?.closing ?? 0n, c.name).label}
                  archived={e.ledger.status === "archived"}
                  chips={[`${e.count} entries`]}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {sharedAccounts.length > 0 && (
        <section className="flex flex-col gap-4">
          <SectionTitle>Shared accounts</SectionTitle>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sharedAccounts.map((l) => {
              const amount = position?.sources.find((s) => s.ledgerId === l.id)?.amount ?? 0n;
              return (
                <li key={l.id}>
                  <WalletCard
                    href={`/ledgers/${l.id}`}
                    color="pink"
                    name={l.name}
                    type="personal"
                    balance={amount}
                    meaning={amount === 0n ? "Settled with you" : amount > 0n ? `${c.name.split(" ")[0]} owes you` : `You owe ${c.name.split(" ")[0]}`}
                    archived={l.status === "archived"}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="flex flex-col gap-4">
          <SectionTitle action={ctx.canWrite && <LinkButton href={`/advances/new?contractor=${c.id}`} size="sm" variant="secondary"><Plus className="size-4" /> Advance</LinkButton>}>
            Advance history
          </SectionTitle>
          {mine.length === 0 ? (
            <p className="text-ink-2">No advances given.</p>
          ) : (
            <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
              {mine.map((a) => (
                <li key={a.id}>
                  <Link href={`/advances/${a.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-white">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{a.purpose || "Advance"}</span>
                      <span className="block text-[13px] text-ink-3">
                        {formatDateShort(a.given_date, today)} · {ADVANCE_STATUS_LABEL[a.position.status]}
                        {a.position.overdue && " · overdue"}
                      </span>
                    </span>
                    <span className="text-right">
                      <Money value={a.position.outstanding} className="block font-semibold" />
                      <span className="text-[12px] text-ink-3">of <Money value={a.position.amount} /></span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="flex flex-col gap-4">
          <SectionTitle>Recent entries</SectionTitle>
          {recentRows.length === 0 ? (
            <p className="text-ink-2">Nothing recorded yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
              {recentRows.map((t) => (
                <li key={t.id}>
                  <Link href={`/ledgers/${t.ledger.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-white">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{t.description || t.voucher_no}</span>
                      <span className="block text-[13px] text-ink-3">{t.ledger.name} · {formatDateShort(t.txn_date, today)}</span>
                    </span>
                    <Money value={toPaise(t.amount)} tone={t.direction === "in" ? "in" : "out"} className={t.status === "void" ? "line-through opacity-50" : "font-semibold"} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {c.notes && (
        <Card>
          <h2 className="mb-1 font-semibold">Notes</h2>
          <p className="whitespace-pre-wrap text-ink-2">{c.notes}</p>
        </Card>
      )}
    </div>
  );
}
