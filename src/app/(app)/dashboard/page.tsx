import { IntentLink } from "@/components/app/intent-link";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, CalendarClock } from "lucide-react";
import { getMyProfile, getWorkspace } from "@/lib/server/context";
import { advancesWithPositions, ledgerBalances } from "@/lib/server/workspace-data";
import { loadSharedAccountRows, peoplePositions } from "@/lib/server/people";
import { loadBooks } from "@/lib/server/books";
import { listContractors } from "@/lib/server/queries";
import { listInvoices } from "@/lib/server/invoices";
import { profitAndLoss } from "@/lib/domain/books";
import { BalanceSheet } from "@/components/app/balance-sheet";
import { PeriodTabs, resolvePeriod } from "@/components/app/period-tabs";
import { Amount, Money } from "@/components/ui/amount";
import { Badge, EmptyState, SectionTitle, walletOf } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { formatINR, toPaise } from "@/lib/domain/money";
import { formatDateShort, relativeTime } from "@/lib/domain/dates";
import { cn } from "@/lib/cn";

export const metadata = { title: "Home" };

export default async function Dashboard(props: PageProps<"/dashboard">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const period = resolvePeriod(params, ctx.workspace.fy_start_month);
  // A single parallel round; no calls to the sign-in provider while rendering.
  const [balances, advances, clients, recent, sharedRows, profile, invoices, contractors] = await Promise.all([
    ledgerBalances(ctx.db, ctx.workspace.id, period.range),
    advancesWithPositions(ctx.db, ctx.workspace.id, period.today),
    ctx.db.from("contractors").select("id", { count: "exact", head: true }).eq("workspace_id", ctx.workspace.id).eq("is_active", true),
    ctx.db
      .from("transactions")
      .select("id, voucher_no, txn_date, direction, amount, kind, description, counterparty, status, created_at, ledger:ledgers(id, name, color)")
      .eq("workspace_id", ctx.workspace.id)
      .order("created_at", { ascending: false })
      .limit(8),
    loadSharedAccountRows(ctx.db),
    getMyProfile(),
    listInvoices(ctx.db, ctx.workspace.id),
    listContractors(ctx.db, ctx.workspace.id),
  ]);

  const books = await loadBooks(ctx.db, ctx.workspace.id, sharedRows);
  const pnl = profitAndLoss(books.lines, period.range);
  const people = peoplePositions(ctx.workspace.id, ctx.userId, balances, sharedRows, invoices, contractors);
  const activeLedgers = balances.entries.filter((e) => e.ledger.status === "active" && !e.ledger.is_direct && !e.ledger.wallet_kind);
  const nothingYet = books.assets === 0n && books.liabilities === 0n && books.lines.length === 0;
  const openAdvances = advances.filter((a) => a.status === "active" && a.position.outstanding > 0n);
  const due = openAdvances
    .filter((a) => a.expected_recovery_date)
    .sort((a, b) => (a.expected_recovery_date! < b.expected_recovery_date! ? -1 : 1))
    .slice(0, 5);
  // The name you entered at setup (or in Settings), never an email handle.
  const firstName = (profile?.full_name ?? "").trim().split(/\s+/)[0] || "there";
  const recentRows = (recent.data ?? []) as unknown as {
    id: string;
    voucher_no: string;
    txn_date: string;
    direction: "in" | "out";
    amount: string;
    kind: string;
    description: string | null;
    counterparty: string | null;
    status: string;
    created_at: string;
    ledger: { id: string; name: string; color: string } | null;
  }[];
  const plural = (n: number) => (n === 1 ? "1 person" : `${n} people`);

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-4 pt-1">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink-2">{ctx.workspace.name}</div>
          <h1 className="display truncate text-[2.6rem] font-extrabold leading-none sm:text-6xl">Hello, {firstName}</h1>
        </div>
        <PeriodTabs basePath="/dashboard" active={period.key} from={params.from} to={params.to} />
      </header>

      {!profile && (
        <Link
          href="/settings#profile"
          className="flex items-center justify-between gap-3 rounded-3xl bg-mustard p-4 font-medium text-ink"
        >
          <span>Add your name and mobile number so people you share with know it’s you.</span>
          <span className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm text-surface">Add</span>
        </Link>
      )}

      {nothingYet ? (
        <EmptyState
          title="Start with one ledger"
          body="A ledger is one running account: a client’s site work, a supplier with GST bills, or a shared account with a friend. Create one and add the first entry in under a minute."
          action={<LinkButton href="/ledgers/new">Create a ledger</LinkButton>}
          art={
            <div className="flex gap-2" aria-hidden>
              <span className="h-14 w-20 rounded-2xl bg-mustard" />
              <span className="h-14 w-14 rounded-2xl bg-lavender" />
              <span className="h-14 w-10 rounded-2xl bg-pink" />
            </div>
          }
        />
      ) : (
        <>
          <BalanceSheet books={books} plural={plural} />
          {people.invitedOwesYou + people.invitedYouOwe > 0n && (
            <p className="text-[13px] text-ink-3">
              Accounts other people run aren&apos;t part of these books: there you are owed {formatINR(people.invitedOwesYou)} and owe {formatINR(people.invitedYouOwe)}.
            </p>
          )}

          {/* The chosen period. Money is what moved; income and costs are what was earned and incurred. */}
          <section aria-label={period.label} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="min-w-0 rounded-[var(--radius-card)] bg-green p-5 text-white sm:p-6">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Money in</span>
                <ArrowDownLeft className="size-5" />
              </div>
              <Amount value={balances.moneyIn} size="lg" className="mt-6 block truncate text-[1.7rem] sm:text-[2.25rem]" />
              <p className="mt-1 truncate text-[13px] opacity-80">{period.label}</p>
            </div>
            <div className="min-w-0 rounded-[var(--radius-card)] bg-red p-5 text-white sm:p-6">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Money out</span>
                <ArrowUpRight className="size-5" />
              </div>
              <Amount value={balances.moneyOut} size="lg" className="mt-6 block truncate text-[1.7rem] sm:text-[2.25rem]" />
              <p className="mt-1 truncate text-[13px] opacity-80">{period.label}</p>
            </div>
            <Tile color="bg-mustard" label="Income" value={pnl.totalIncome} href="/books" note="Invoiced and earned, before GST" />
            <Tile color="bg-lavender" label={pnl.profit < 0n ? "Loss" : "Profit"} value={pnl.profit < 0n ? -pnl.profit : pnl.profit} href="/books" note={`After ${formatINR(pnl.totalCosts)} of costs`} />
          </section>

          <p className="text-[15px] text-ink-2">
            <Link href="/contractors" className="font-semibold text-ink underline-offset-4 hover:underline">
              {clients.count ?? 0} client accounts
            </Link>{" "}
            ·{" "}
            <Link href="/ledgers" className="font-semibold text-ink underline-offset-4 hover:underline">
              {activeLedgers.length} active ledgers
            </Link>
          </p>

          <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
            <section className="flex flex-col gap-4">
              <SectionTitle>Latest entries</SectionTitle>
              {recentRows.length === 0 ? (
                <p className="text-ink-2">No entries yet.</p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
                  {recentRows.map((t) => (
                    <li key={t.id}>
                      <IntentLink href={`/ledgers/${t.ledger?.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-white sm:px-5">
                        <span className={cn("size-3 shrink-0 rounded-full", walletOf(t.ledger?.color).bg)} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium">{t.description || t.counterparty || t.voucher_no}</span>
                          <span className="block truncate text-[13px] text-ink-3">
                            {t.ledger?.name} · {formatDateShort(t.txn_date, period.today)} · {relativeTime(t.created_at)}
                          </span>
                        </span>
                        <span className="text-right">
                          <Money
                            value={toPaise(t.amount)}
                            tone={t.direction === "in" ? "in" : "out"}
                            className={cn("text-[15px] font-semibold", t.status === "void" && "line-through opacity-50")}
                          />
                          {t.status !== "posted" && (
                            <Badge className="ml-2" tone={t.status === "void" ? "neutral" : "warn"}>
                              {t.status}
                            </Badge>
                          )}
                        </span>
                      </IntentLink>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-4">
              <SectionTitle>Recoveries due</SectionTitle>
              {due.length === 0 ? (
                <p className="rounded-[var(--radius-card)] bg-surface p-5 text-ink-2 ring-1 ring-inset ring-line/70">
                  No advance has a recovery date coming up.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {due.map((a) => (
                    <li key={a.id}>
                      <Link
                        href={`/advances/${a.id}`}
                        className="flex items-center gap-3 rounded-3xl bg-surface p-4 ring-1 ring-inset ring-line/70 hover:bg-white"
                      >
                        <CalendarClock className={cn("size-5 shrink-0", a.position.overdue ? "text-out" : "text-ink-3")} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{a.contractor?.name}</span>
                          <span className={cn("block text-[13px]", a.position.overdue ? "font-medium text-out" : "text-ink-3")}>
                            {a.position.overdue ? "Overdue since" : "Due"} {formatDateShort(a.expected_recovery_date!, period.today)}
                          </span>
                        </span>
                        <Money value={a.position.outstanding} className="font-semibold" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ color, label, value, note, href }: { color: string; label: string; value: bigint; note: string; href: string }) {
  return (
    <IntentLink
      href={href}
      className={cn("flex min-h-36 min-w-0 flex-col justify-between rounded-[var(--radius-card)] p-5 text-ink transition-transform active:scale-[0.99]", color)}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className="min-w-0">
        <Amount value={value} size="lg" className="block truncate text-[1.7rem] sm:text-[2.25rem]" />
        <span className="mt-1 block truncate text-[13px] opacity-70">{note}</span>
      </span>
    </IntentLink>
  );
}
