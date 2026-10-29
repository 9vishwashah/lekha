import type { Metadata } from "next";
import { Download } from "lucide-react";
import { loadShared, sharedPersonalRecords } from "@/lib/server/shared";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { buildStatement, describeBalance, KIND_LABEL, type Perspective } from "@/lib/domain/ledger";
import { participantBalances, simplifyDebts } from "@/lib/domain/split";
import { toPaise, formatINR } from "@/lib/domain/money";
import { formatDate, formatDateShort, todayISO } from "@/lib/domain/dates";
import { Amount, Money } from "@/components/ui/amount";
import { Avatar, Badge, walletOf } from "@/components/ui/bits";
import { Logo } from "@/components/app/logo";
import { SharedLive } from "./live";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";
import { cn } from "@/lib/cn";

// Always rendered per request: private data, and configuration is read at runtime.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ledger statement", robots: { index: false, follow: false }, referrer: "no-referrer" };

const COLOR = { basic: "mustard", taxation: "lavender", personal: "pink" } as const;

export default async function SharedLedger(props: PageProps<"/s/[token]">) {
  const { token } = await props.params;
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  if (!allow(await clientKey("share-page"), 60, 60_000)) return <Inactive title="Too many requests" body="Wait a minute and refresh the page." />;
  const shared = await loadShared(token);
  if (!shared) return <Inactive title="This link is no longer active" body="Ask the person who sent it for a new link." />;

  const { ledger, options } = shared;
  const w = walletOf(COLOR[ledger.ledger_type]);
  const today = todayISO();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 overflow-x-clip px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
      <header className="flex items-center justify-between gap-3">
        <span className="text-sm text-ink-3">Statement shared with you</span>
        <SharedLive token={token} version={ledger.last_activity_at} />
      </header>

      {ledger.ledger_type === "personal" ? (
        <PersonalView shared={shared} wBg={w.bg} today={today} />
      ) : (
        <CashView shared={shared} wBg={w.bg} wSub={w.sub} today={today} />
      )}

      <div className="flex flex-wrap gap-2">
        <a href={`/api/share/${token}?format=pdf`} className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-5 font-medium text-surface">
          <Download className="size-4" /> Download PDF
        </a>
        <a href={`/api/share/${token}?format=csv`} className="inline-flex h-12 items-center gap-2 rounded-full px-5 font-medium ring-1 ring-inset ring-line">
          CSV
        </a>
      </div>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[13px] text-ink-3">
        <Logo compact />
        <span>Read-only. Only what the owner chose to share is shown.{options.show_balance ? "" : " Balances are hidden."}</span>
      </footer>
    </div>
  );
}

function CashView({
  shared,
  wBg,
  wSub,
  today,
}: {
  shared: NonNullable<Awaited<ReturnType<typeof loadShared>>>;
  wBg: string;
  wSub: string;
  today: string;
}) {
  const { ledger, options, transactions } = shared;
  const perspective = ledger.perspective as Perspective;
  const s = buildStatement({ perspective, opening_balance: ledger.opening_balance ?? "0" }, transactions);
  const meaning = describeBalance(perspective, s.closing, ledger.contractor_name);
  const rows = [...s.lines].reverse();
  const showTax = options.show_tax && ledger.ledger_type === "taxation";

  return (
    <>
      <section className={cn("rounded-[32px] p-6 sm:p-8", wBg)}>
        <div className={cn("text-sm font-medium", wSub)}>{ledger.ledger_type === "taxation" ? "Taxation ledger" : "Ledger"}</div>
        <h1 className="display mt-1 text-[2.4rem] font-extrabold sm:text-6xl">{ledger.name}</h1>
        {ledger.contractor_name && <div className={cn("mt-1 font-medium", wSub)}>with {ledger.contractor_name}</div>}
        {options.show_balance && (
          <div className="mt-10">
            <div className="text-[15px] font-semibold">{meaning.label.replace("owes you", "owes the ledger owner").replace("You owe", "Owner owes")}</div>
            <Amount value={perspective === "party" && s.closing < 0n ? -s.closing : s.closing} size="hero" className="block" />
          </div>
        )}
        <dl className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {options.show_balance && (
            <div>
              <dt className={cn("text-[13px]", wSub)}>Opening{ledger.opening_balance_date ? ` (${formatDate(ledger.opening_balance_date)})` : ""}</dt>
              <dd><Amount value={s.opening} size="sm" /></dd>
            </div>
          )}
          <div>
            <dt className={cn("text-[13px]", wSub)}>Money in</dt>
            <dd><Amount value={s.totals.moneyIn} size="sm" /></dd>
          </div>
          <div>
            <dt className={cn("text-[13px]", wSub)}>Money out</dt>
            <dd><Amount value={s.totals.moneyOut} size="sm" /></dd>
          </div>
        </dl>
      </section>

      {rows.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border-2 border-dashed border-line p-8 text-center text-ink-2">No entries yet.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
          {rows.map(({ row, counted, running }) => {
            const t = row;
            return (
              <li key={t.voucher_no} className="flex flex-col gap-1 px-4 py-3.5 sm:px-5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{t.description || t.counterparty || KIND_LABEL[t.kind]}</div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-3">
                      {formatDateShort(t.txn_date, today)} · {t.voucher_no}
                      {t.counterparty && t.description && ` · ${t.counterparty}`}
                      {t.reference_no && ` · Ref ${t.reference_no}`}
                      {t.kind !== "regular" && <Badge className="h-5">{KIND_LABEL[t.kind]}</Badge>}
                    </div>
                  </div>
                  <div className="text-right">
                    <Money value={toPaise(t.amount)} tone={t.direction === "in" ? "in" : "out"} className="block font-semibold" />
                    <span className="text-[12px] text-ink-3">{t.direction === "in" ? "credit" : "debit"}</span>
                    {options.show_balance && options.show_running_balance && counted && (
                      <Money value={running} className="block text-[12px] text-ink-3" />
                    )}
                  </div>
                </div>
                {showTax && t.tax && (
                  <div className="num rounded-xl bg-lavender/20 px-3 py-2 text-[12px] text-ink-2">
                    Bill {formatINR(toPaise(t.tax.taxable_amount))} + GST {formatINR(toPaise(t.tax.gst_amount))} − TDS {formatINR(toPaise(t.tax.tds_amount))} ={" "}
                    <strong className="text-ink">{formatINR(toPaise(t.tax.net_amount))}</strong>
                    {t.tax.invoice_no && ` · Invoice ${t.tax.invoice_no}`}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function PersonalView({ shared, wBg, today }: { shared: NonNullable<Awaited<ReturnType<typeof loadShared>>>; wBg: string; today: string }) {
  const records = sharedPersonalRecords(shared);
  const ids = records.participants.map((p) => p.id);
  const balances = participantBalances(ids, records.expenses, records.settlements);
  const debts = simplifyDebts(balances, ids);
  const name = (id: string) => records.participants.find((p) => p.id === id)?.name ?? "";
  const items = [
    ...records.expenses.map((e) => ({ date: e.txn_date, kind: "expense" as const, e })),
    ...records.settlements.map((s) => ({ date: s.txn_date, kind: "repayment" as const, s })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <>
      <section className={cn("rounded-[32px] p-6 sm:p-8", wBg)}>
        <div className="text-sm font-medium text-ink/65">Shared account</div>
        <h1 className="display mt-1 text-[2.4rem] font-extrabold sm:text-6xl">{shared.ledger.name}</h1>
        <ul className="mt-8 flex flex-col gap-2">
          {debts.length === 0 ? (
            <li className="display text-3xl font-bold">All settled</li>
          ) : (
            debts.map((d) => (
              <li key={`${d.from}${d.to}`} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="display text-2xl font-bold">
                  {name(d.from)} owes {name(d.to)}
                </span>
                <Amount value={d.amount} size="lg" />
              </li>
            ))
          )}
        </ul>
      </section>
      <section className="grid gap-2 sm:grid-cols-2">
        {records.participants.map((p) => {
          const b = balances.get(p.id)!;
          return (
            <div key={p.id} className="flex items-center gap-3 rounded-3xl bg-surface p-4 ring-1 ring-inset ring-line/70">
              <Avatar name={p.name} />
              <span className="flex-1 font-semibold">{p.name}</span>
              <span className="num text-right text-sm">
                paid {formatINR(b.paid)}
                <span className="block text-ink-3">share {formatINR(b.share)}</span>
              </span>
            </div>
          );
        })}
      </section>
      <ul className="flex flex-col gap-2">
        {items.map((it, i) =>
          it.kind === "expense" ? (
            <li key={i} className="flex items-center gap-3 rounded-3xl bg-surface p-4 ring-1 ring-inset ring-line/70">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{it.e.description}</span>
                <span className="block truncate text-[13px] text-ink-3">
                  {formatDateShort(it.e.txn_date, today)} · {it.e.payers.map((p) => `${name(p.participant_id)} paid ${formatINR(toPaise(p.amount_paid))}`).join(", ")}
                </span>
              </span>
              <Money value={toPaise(it.e.total_amount)} className="font-semibold" />
            </li>
          ) : (
            <li key={i} className="flex items-center gap-3 rounded-3xl bg-tea/10 p-4 ring-1 ring-inset ring-tea/30">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  {name(it.s.from_participant_id)} paid {name(it.s.to_participant_id)}
                </span>
                <span className="block text-[13px] text-ink-3">Repayment · {formatDateShort(it.s.txn_date, today)}</span>
              </span>
              <Money value={toPaise(it.s.amount)} className="font-semibold" />
            </li>
          ),
        )}
      </ul>
    </>
  );
}

function Inactive({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4">
      <Logo />
      <h1 className="display text-5xl font-extrabold">{title}</h1>
      <p className="text-lg text-ink-2">{body}</p>
    </div>
  );
}
