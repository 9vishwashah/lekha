import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, MapPin, Phone, Plus } from "lucide-react";
import { getMyProfile, getWorkspace } from "@/lib/server/context";
import { avatarUrl } from "@/lib/avatar";
import { getPersonalLedger, isUuid, listContractors, listLedgers, walletsOf } from "@/lib/server/queries";
import { listInvoices } from "@/lib/server/invoices";
import { advancesWithPositions, ledgerBalances } from "@/lib/server/workspace-data";
import { externalNet, loadSharedAccountRows, peoplePositions } from "@/lib/server/people";
import { loadBooks } from "@/lib/server/books";
import { describeBalance, type Perspective } from "@/lib/domain/ledger";
import { expenseEffect } from "@/lib/domain/split";
import { sum, toPaise } from "@/lib/domain/money";
import { formatDateShort, todayISO } from "@/lib/domain/dates";
import { ShareClientAccount } from "./share";
import { ActivityList } from "./activity";
import { ClientEmail } from "./email";
import { emailConfigured } from "@/lib/email/send";
import { ADVANCE_STATUS_LABEL } from "@/lib/domain/advances";
import { Amount, Money } from "@/components/ui/amount";
import { Avatar, Badge, Card, SectionTitle } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { WalletCard } from "@/components/app/wallet-card";
import { ContractorActions } from "./actions";
import { ConnectCard } from "./connect";
import { AdoptAccount, ClientMoneyButtons } from "./money";
import { whatsappNumber } from "@/lib/server/share-card";
import { loadPeople } from "@/lib/server/profiles";

export default async function ContractorPage(props: PageProps<"/contractors/[id]">) {
  const ctx = await getWorkspace();
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const today = todayISO();
  // One parallel round; this client comes from the same list the merge picker needs.
  const [balances, advances, all, recent, taxIds, sharedRows, allLedgers, invoices] = await Promise.all([
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
    listLedgers(ctx.db, ctx.workspace.id),
    listInvoices(ctx.db, ctx.workspace.id),
  ]);
  const c = all.find((x) => x.id === id);
  if (!c) notFound();
  const [account, profile, matchRows, emailRow] = await Promise.all([
    c.linked_user_id ? loadPeople(ctx.db, [c.linked_user_id]).then((m) => m.get(c.linked_user_id!) ?? null) : Promise.resolve(null),
    getMyProfile(),
    ctx.canWrite && !c.linked_user_id && c.phone ? ctx.db.rpc("client_lekha_matches", { p_workspace: ctx.workspace.id }) : Promise.resolve({ data: [] }),
    ctx.db.from("contractors").select("monthly_statement, last_reminded_at").eq("id", id).maybeSingle(),
  ]);
  const emailState = (emailRow.data as { monthly_statement: boolean; last_reminded_at: string | null } | null) ?? { monthly_statement: false, last_reminded_at: null };
  const found = ((matchRows.data as { contractor_id: string; username: string; full_name: string; avatar_path: string | null }[] | null) ?? []).find((m) => m.contractor_id === id);
  const position = peoplePositions(ctx.workspace.id, ctx.userId, balances, sharedRows, invoices, all).byClient.get(id);
  // Your books: every ledger, invoice, advance and account with them, netted.
  const books = await loadBooks(ctx.db, ctx.workspace.id, sharedRows);
  const overall = books.positions.get(id) ?? 0n;
  const addsUp = books.breakdown.get(id) ?? [];
  const theirs = externalNet(position);
  const first = c.name.split(" ")[0];
  // Accounts they run that you are in show here too, on the card linking made for them.
  const sharedLedgerIds = new Set(sharedRows.participants.filter((p) => p.contractor_id === id || (c.linked_user_id && p.user_id === c.linked_user_id)).map((p) => p.ledger_id));
  const directLedger = sharedRows.ledgers.find((l) => l.is_direct && l.workspace_id === ctx.workspace.id && l.contractor_id === id && sharedLedgerIds.has(l.id));
  // One-to-one accounts they keep with you in their own Lekha (made when they add an expense or a
  // payment with you). Like yours, they are not shown as separate accounts: their entries are rows here.
  const theirDirect = sharedRows.ledgers.filter((l) => l.is_direct && l.workspace_id !== ctx.workspace.id && sharedLedgerIds.has(l.id));
  const hidden = new Set([directLedger?.id, ...theirDirect.map((l) => l.id)].filter(Boolean));
  const sharedAccounts = sharedRows.ledgers.filter((l) => sharedLedgerIds.has(l.id) && !hidden.has(l.id));
  const peopleIn = (ledgerId: string) => sharedRows.participants.filter((p) => p.ledger_id === ledgerId).length;
  const ledgers = balances.entries.filter((e) => e.ledger.contractor_id === id && e.ledger.ledger_type !== "personal");
  const [direct, theirs_] = await Promise.all([
    directLedger ? getPersonalLedger(ctx.db, directLedger.id) : Promise.resolve(null),
    Promise.all(theirDirect.map(async (l) => ({ ledger: l, data: await getPersonalLedger(ctx.db, l.id) }))),
  ]);
  const clientSide = direct?.participants.find((p) => p.contractor_id === id);
  const mine = advances.filter((a) => a.contractor_id === id);
  const active = mine.filter((a) => a.status === "active");
  const given = sum(active.map((a) => a.position.amount));
  const recovered = sum(active.map((a) => a.position.recovered));
  const adjusted = sum(active.map((a) => a.position.adjusted));
  const outstanding = sum(active.map((a) => a.position.outstanding));
  const overdue = active.filter((a) => a.position.overdue);
  const recentRows = (recent.data ?? []) as unknown as { id: string; voucher_no: string; txn_date: string; direction: "in" | "out"; amount: string; description: string | null; status: string; ledger: { id: string; name: string } }[];

  // Everything on one line per event, signed from your side: + you gave, − you got. On the direct
  // account the two tiles therefore differ by exactly what is owed.
  const activity = [
    ...invoices
      .filter((i) => i.contractor_id === id && i.status === "issued" && i.invoice_type !== "proforma" && !i.transaction_id)
      .map((i) => ({
        key: i.id,
        date: i.invoice_date,
        title: `Invoice ${i.invoice_no ?? ""}`.trim(),
        from: toPaise(i.amount_received) >= toPaise(i.grand_total) ? "Invoice · paid" : "Invoice",
        amount: toPaise(i.grand_total),
        void: false,
        href: `/invoices/${i.id}` as string | undefined,
        entry: undefined,
      })),
    ...recentRows.map((t) => ({
      key: t.id,
      date: t.txn_date,
      title: t.description || t.voucher_no,
      from: t.ledger.name,
      amount: t.direction === "out" ? toPaise(t.amount) : -toPaise(t.amount),
      void: t.status === "void",
      href: `/ledgers/${t.ledger.id}` as string | undefined,
      entry: undefined,
    })),
    ...(direct?.expenses ?? []).map((e) => ({
      key: e.id,
      date: e.txn_date,
      title: e.description,
      from: e.split_group_id ? "Split expense" : "Expense",
      amount: clientSide ? -expenseEffect(e, clientSide.id).effect : 0n,
      void: e.status === "void",
      href: undefined as string | undefined,
      entry: { kind: "expense" as const, id: e.id, ledgerId: directLedger!.id, mine: true, total: String(toPaise(e.total_amount)) },
    })),
    ...(direct?.settlements ?? []).map((s) => ({
      key: s.id,
      date: s.txn_date,
      title: s.from_participant_id === clientSide?.id ? "Payment received" : "Payment made",
      from: "Payment",
      amount: s.from_participant_id === clientSide?.id ? -toPaise(s.amount) : toPaise(s.amount),
      void: s.status === "void",
      href: undefined as string | undefined,
      entry: { kind: "settlement" as const, id: s.id, ledgerId: directLedger!.id, mine: true },
    })),
    // Entries they added in their own Lekha, signed from your side the same way.
    ...theirs_.flatMap(({ ledger: l, data }) => {
      const me = data.participants.find((p) => p.user_id === ctx.userId);
      if (!me) return [];
      return [
        ...data.expenses.map((e) => ({
          key: e.id,
          date: e.txn_date,
          title: e.description,
          from: `Added by ${first}`,
          amount: expenseEffect(e, me.id).effect,
          void: e.status === "void",
          href: undefined as string | undefined,
          entry: { kind: "expense" as const, id: e.id, ledgerId: l.id, mine: false, total: String(toPaise(e.total_amount)) },
        })),
        ...data.settlements.map((s) => ({
          key: s.id,
          date: s.txn_date,
          title: s.from_participant_id === me.id ? "Payment made" : "Payment received",
          from: `Added by ${first}`,
          amount: s.from_participant_id === me.id ? toPaise(s.amount) : -toPaise(s.amount),
          void: s.status === "void",
          href: undefined as string | undefined,
          entry: { kind: "settlement" as const, id: s.id, ledgerId: l.id, mine: false },
        })),
      ];
    }),
  ].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const directIds = new Set(
    [...(direct?.expenses ?? []), ...(direct?.settlements ?? []), ...theirs_.flatMap((t) => [...t.data.expenses, ...t.data.settlements])].map((x) => x.id),
  );
  const counted = activity.filter((a) => !a.void && directIds.has(a.key));
  const youGot = sum(ledgers.map((e) => e.statement?.totals.moneyIn ?? 0n)) + sum(counted.filter((a) => a.amount < 0n).map((a) => -a.amount));
  const youGave = sum(ledgers.map((e) => e.statement?.totals.moneyOut ?? 0n)) + sum(counted.filter((a) => a.amount > 0n).map((a) => a.amount));
  const cashLedgers = walletsOf(allLedgers);
  // Your books plus what they recorded with you in their own Lekha: one figure.
  const together = overall + theirs;

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
          <span className="text-sm font-semibold text-ink-2">{together === 0n ? "All square" : together > 0n ? `${first} owes you` : `You owe ${first}`}</span>
          <Amount value={together > 0n ? together : -together} size="xl" tone={together > 0n ? "in" : together < 0n ? "out" : "inherit"} />
          <span className="text-[13px] text-ink-3">
            {theirs !== 0n ? `Includes what ${first} added on their side` : "Across ledgers, invoices, advances and expenses together"}
          </span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {ctx.canWrite && c.is_active && <ClientMoneyButtons client={{ id: c.id, name: c.name }} cashLedgers={cashLedgers} today={today} />}
        {ctx.canWrite && c.is_active && (
          <ClientEmail
            client={{ id: c.id, name: c.name, email: c.email }}
            owes={String(overall > 0n ? overall : 0n)}
            monthlyOn={emailState.monthly_statement}
            lastReminded={emailState.last_reminded_at}
            ready={emailConfigured()}
          />
        )}
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
            <Plus className="size-4" /> Group account
          </LinkButton>
        )}
      </div>

      {addsUp.length > 1 && (
        <section aria-label="How this adds up" className="rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70">
          <h2 className="text-sm font-semibold">How {overall === 0n ? "this evens out" : "this adds up"}</h2>
          <ul className="mt-2 divide-y divide-line text-[15px]">
            {addsUp.map((s, i) => (
              <li key={`${s.href}${i}`}>
                <Link href={s.href} className="flex min-h-12 items-center justify-between gap-3 py-2 hover:opacity-80">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{s.label}</span>
                    <span className="block text-[12px] text-ink-3">{s.note}</span>
                  </span>
                  <span className="text-right">
                    <Money value={s.amount > 0n ? s.amount : -s.amount} tone={s.amount > 0n ? "in" : "out"} className="block font-semibold" />
                    <span className="text-[12px] text-ink-3">{s.amount > 0n ? "they owe you" : "you owe"}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConnectCard
        contractor={{ id: c.id, name: c.name }}
        account={account ?? (c.linked_user_id ? { username: null, fullName: c.name, photo: null } : null)}
        canWrite={ctx.canWrite && c.is_active}
        whatsappTo={whatsappNumber(c.phone)}
        match={found ? { username: found.username, fullName: found.full_name, photo: avatarUrl(found.avatar_path) } : null}
        me={{ name: profile?.full_name ?? null, username: profile?.username ?? null }}
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
          <div className="text-sm font-medium opacity-75">You got</div>
          <Amount value={youGot} size="lg" className="mt-4 block text-[1.6rem] sm:text-[2.2rem]" />
        </div>
        <div className="rounded-[var(--radius-card)] bg-ink p-5 text-seashell">
          <div className="text-sm font-medium opacity-75">You gave</div>
          <Amount value={youGave} size="lg" className="mt-4 block text-[1.6rem] sm:text-[2.2rem]" />
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
        <SectionTitle
          action={
            directLedger && (
              <div className="flex gap-2">
                {ctx.canWrite && <ShareClientAccount ledgerId={directLedger.id} name={c.name} />}
              </div>
            )
          }
        >
          Activity with {first}
        </SectionTitle>
        {activity.length === 0 ? (
          <p className="text-ink-2">Nothing yet. {ctx.canWrite && c.is_active ? "Add an expense or record a payment to start." : ""}</p>
        ) : (
          <ActivityList
            rows={activity.slice(0, 300).map((a) => ({ key: a.key, date: a.date, title: a.title, from: a.from, amount: String(a.amount), void: a.void, href: a.href, entry: a.entry }))}
            today={today}
            first={first}
            canWrite={ctx.canWrite}
          />
        )}
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
              const amount = addsUp.find((s) => s.href === `/ledgers/${l.id}`)?.amount ?? position?.sources.find((s) => s.ledgerId === l.id)?.amount ?? 0n;
              return (
                <li key={l.id}>
                  <WalletCard
                    href={`/ledgers/${l.id}`}
                    color="pink"
                    name={l.name}
                    type="personal"
                    balance={amount}
                    meaning={amount === 0n ? "Settled with you" : amount > 0n ? `${first} owes you` : `You owe ${first}`}
                    archived={l.status === "archived"}
                  />
                  {ctx.canWrite && !directLedger && l.status === "active" && peopleIn(l.id) === 2 && (
                    <AdoptAccount ledgerId={l.id} ledgerName={l.name} clientName={first} />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="flex flex-col gap-8">
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
