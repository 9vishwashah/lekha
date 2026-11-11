import type { ReactNode } from "react";
import type { SharedPayload } from "@/lib/server/shared";
import { sharedPersonalRecords } from "@/lib/server/shared";
import { buildStatement, describeBalance, KIND_LABEL, type Perspective } from "@/lib/domain/ledger";
import { participantBalances, simplifyDebts } from "@/lib/domain/split";
import { toPaise, formatINR } from "@/lib/domain/money";
import { formatDate, formatDateShort } from "@/lib/domain/dates";
import { Amount, Money } from "@/components/ui/amount";
import { Avatar, Badge } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { DateTile } from "@/components/ui/date-tile";
import { SharedSearch } from "@/components/app/shared-search";
import { searchText } from "@/lib/domain/search";

/*
 * Read-only statement views of one ledger, as seen through a share link or an open invitation.
 * They only render what the public payload contains (already filtered by the link's settings).
 */

export function CashView({
  shared,
  wBg,
  wSub,
  today,
  searchAction,
}: {
  shared: SharedPayload;
  wBg: string;
  wSub: string;
  today: string;
  /** Shown beside the search box (the share page puts "Confirm statement" there). */
  searchAction?: ReactNode;
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
              <dt className={cn("text-[13px]", wSub)}>Opening{ledger.opening_balance_date && s.opening !== 0n ? ` (${formatDate(ledger.opening_balance_date)})` : ""}</dt>
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
        <SharedSearch
          action={searchAction}
          items={rows.map(({ row, counted, running }, i) => {
            const t = row;
            return {
              key: `${t.voucher_no}-${i}`,
              text: searchText(t),
              node: (
              <li
                key={`${t.voucher_no}-${i}`}
                className={cn("flex flex-col gap-2 rounded-3xl p-4 ring-1 ring-inset", t.direction === "in" ? "bg-in-soft ring-in/20" : "bg-surface ring-line/70")}
              >
                <div className="flex items-center gap-3">
                  <DateTile date={t.txn_date} today={today} direction={t.direction} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{t.counterparty || t.description || KIND_LABEL[t.kind]}</div>
                    {t.counterparty && t.description && t.description !== t.counterparty && <div className="truncate text-[14px] text-ink-2">{t.description}</div>}
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-3">
                      {t.voucher_no}
                      {t.reference_no && ` · Ref ${t.reference_no}`}
                      {t.kind !== "regular" && <Badge className="h-5">{KIND_LABEL[t.kind]}</Badge>}
                    </div>
                  </div>
                  <div className="text-right">
                    <Money value={toPaise(t.amount)} tone={t.direction === "in" ? "in" : "out"} className="block font-semibold" />
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
              ),
            };
          })}
        />
      )}
    </>
  );
}

export function PersonalView({ shared, wBg, today }: { shared: SharedPayload; wBg: string; today: string }) {
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
        <div className="text-sm font-medium opacity-70">Shared account</div>
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
