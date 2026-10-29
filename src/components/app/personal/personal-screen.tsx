"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Download, HandCoins, Plus, Settings2, Share2 } from "lucide-react";
import { Amount, Money } from "@/components/ui/amount";
import { Avatar, Badge, walletOf } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Field, Input, MoneyInput, Select } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { SplitComposer } from "./split-composer";
import { ShareSheet } from "../share-sheet";
import { LiveRefresh } from "../live-refresh";
import { recordRepayment, voidRepayment, voidSharedExpense } from "@/app/(app)/actions/records";
import { expenseEffect } from "@/lib/domain/split";
import { formatINR, toPaise, tryPaise } from "@/lib/domain/money";
import { formatDate, formatDateShort, formatDateTime, relativeTime } from "@/lib/domain/dates";
import type { LedgerAccess } from "@/lib/server/access";
import { PAYMENT_MODES, type SharedExpense, type Settlement } from "@/lib/types";
import { cn } from "@/lib/cn";

interface P {
  id: string;
  name: string;
  linked: boolean;
  isViewer: boolean;
  paid: string;
  share: string;
  net: string;
}

type Item = { type: "expense"; date: string; at: string; e: SharedExpense } | { type: "repayment"; date: string; at: string; s: Settlement };

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function PersonalScreen({
  ledger,
  participants,
  debts,
  expenses,
  settlements,
  viewerId,
  userId,
  access,
  names,
  today,
  openAdd,
}: {
  ledger: { id: string; name: string; color: string; status: string; lastActivity: string };
  participants: P[];
  debts: { from: string; to: string; amount: string }[];
  expenses: SharedExpense[];
  settlements: Settlement[];
  viewerId: string | null;
  userId: string;
  access: LedgerAccess;
  names: Record<string, string>;
  today: string;
  openAdd: boolean;
}) {
  const router = useRouter();
  const w = walletOf(ledger.color);
  const [adding, setAdding] = useState(openAdd && access.canCreate && ledger.status !== "archived");
  const [correcting, setCorrecting] = useState<SharedExpense | null>(null);
  const [repaying, setRepaying] = useState<{ from: string; to: string; amount: string } | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [share, setShare] = useState(false);
  const archived = ledger.status === "archived";
  const canAdd = access.canCreate && !archived;
  const person = (id: string) => participants.find((p) => p.id === id);
  const label = (id: string) => (id === viewerId ? "You" : (person(id)?.name ?? "Someone"));

  useEffect(() => {
    if (openAdd) router.replace(`/ledgers/${ledger.id}`, { scroll: false });
  }, [openAdd, router, ledger.id]);

  const me = viewerId ? person(viewerId) : null;
  const myNet = me ? toPaise(me.net) : 0n;
  const youOwe = debts.filter((d) => d.from === viewerId);
  const owedToYou = debts.filter((d) => d.to === viewerId);
  const totalShared = expenses.filter((e) => e.status === "posted").reduce((a, e) => a + toPaise(e.total_amount), 0n);

  const headline = !me
    ? "Shared account"
    : myNet === 0n
      ? "All settled"
      : participants.length === 2
        ? myNet > 0n
          ? `${participants.find((p) => !p.isViewer)?.name} owes you`
          : `You owe ${participants.find((p) => !p.isViewer)?.name}`
        : myNet > 0n
          ? "You are owed"
          : "You owe";

  const items: Item[] = useMemo(
    () =>
      [
        ...expenses.map((e) => ({ type: "expense" as const, date: e.txn_date, at: e.created_at, e })),
        ...settlements.map((s) => ({ type: "repayment" as const, date: s.txn_date, at: s.created_at, s })),
      ].sort((a, b) => (a.date === b.date ? (a.at < b.at ? 1 : -1) : a.date < b.date ? 1 : -1)),
    [expenses, settlements],
  );
  const history = settlements.filter((s) => s.status === "posted");

  const canEdit = (createdBy: string) => !archived && (access.canEditAll || (access.canEditOwn && createdBy === userId));

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print flex items-center justify-between">
        <Link href={access.kind === "member" ? "/ledgers" : "/shared"} className="inline-flex h-11 items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
          <ArrowLeft className="size-4" /> {access.kind === "member" ? "Ledgers" : "Shared with me"}
        </Link>
        <LiveRefresh ledgerId={ledger.id} tables={["shared_expenses", "settlements", "ledgers"]} />
      </div>

      <section className={cn("rounded-[32px] p-6 sm:p-8", w.bg, w.fg)}>
        <div className={cn("text-sm font-medium", w.sub)}>Shared account · {participants.length} people</div>
        <h1 className="display mt-1 text-[2.4rem] font-extrabold sm:text-6xl">{ledger.name}</h1>
        <div className="mt-10">
          <div className="text-[15px] font-semibold">{headline}</div>
          <Amount value={myNet < 0n ? -myNet : myNet} size="hero" className="block" />
          <div className={cn("text-[13px]", w.sub)}>Updated {relativeTime(ledger.lastActivity)}</div>
        </div>
        {(youOwe.length > 0 || owedToYou.length > 0) && participants.length > 2 && (
          <ul className="mt-4 flex flex-wrap gap-2">
            {youOwe.map((d) => (
              <li key={d.to} className={cn("rounded-full px-3 py-1.5 text-sm font-medium", w.chip)}>
                You owe {label(d.to)} {formatINR(toPaise(d.amount))}
              </li>
            ))}
            {owedToYou.map((d) => (
              <li key={d.from} className={cn("rounded-full px-3 py-1.5 text-sm font-medium", w.chip)}>
                {label(d.from)} owes you {formatINR(toPaise(d.amount))}
              </li>
            ))}
          </ul>
        )}
        <dl className="mt-8 grid grid-cols-3 gap-3">
          <div>
            <dt className={cn("text-[13px]", w.sub)}>Total shared</dt>
            <dd>
              <Amount value={totalShared} size="sm" />
            </dd>
          </div>
          <div>
            <dt className={cn("text-[13px]", w.sub)}>You paid</dt>
            <dd>
              <Amount value={me ? toPaise(me.paid) : 0n} size="sm" />
            </dd>
          </div>
          <div>
            <dt className={cn("text-[13px]", w.sub)}>Your share</dt>
            <dd>
              <Amount value={me ? toPaise(me.share) : 0n} size="sm" />
            </dd>
          </div>
        </dl>
      </section>

      <div className="no-print -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&>*]:shrink-0">
        {canAdd && (
          <Button size="lg" onClick={() => setAdding(true)}>
            <Plus className="size-5" /> Add expense
          </Button>
        )}
        {canAdd && debts.length > 0 && (
          <Button
            size="lg"
            variant="secondary"
            onClick={() => setRepaying(youOwe[0] ?? owedToYou[0] ?? debts[0])}
          >
            <HandCoins className="size-4" /> Record repayment
          </Button>
        )}
        {access.canManage && (
          <Button size="lg" variant="secondary" onClick={() => setShare(true)}>
            <Share2 className="size-4" /> Share
          </Button>
        )}
        <a href={`/api/export/ledger/${ledger.id}?format=pdf`} className="inline-flex h-14 items-center gap-2 rounded-full px-5 text-[15px] font-medium hover:bg-sunken">
          <Download className="size-4" /> PDF
        </a>
        <a href={`/api/export/ledger/${ledger.id}?format=xlsx`} className="inline-flex h-14 items-center gap-2 rounded-full px-5 text-[15px] font-medium hover:bg-sunken">
          <Download className="size-4" /> Excel
        </a>
        {access.canManage && (
          <Link href={`/ledgers/${ledger.id}/settings`} className="inline-flex h-14 items-center gap-2 rounded-full px-5 text-[15px] font-medium hover:bg-sunken">
            <Settings2 className="size-4" /> People & settings
          </Link>
        )}
      </div>

      {/* People */}
      <section aria-label="People" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {participants.map((p) => {
          const net = toPaise(p.net);
          return (
            <div key={p.id} className="flex items-center gap-3 rounded-3xl bg-surface p-4 ring-1 ring-inset ring-line/70">
              <Avatar name={p.name} tone={p.isViewer ? "ink" : "sunken"} className="size-11" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">
                  {p.name}
                  {p.isViewer && <span className="font-normal text-ink-3"> (you)</span>}
                </div>
                <div className="text-[13px] text-ink-3">{p.linked ? "Has joined" : "Not invited yet"}</div>
              </div>
              <div className="text-right">
                <div className={cn("num text-[15px] font-semibold", net > 0n ? "text-in" : net < 0n ? "text-out" : "text-ink-3")}>
                  {net === 0n ? "Settled" : formatINR(net > 0n ? net : -net)}
                </div>
                <div className="text-[12px] text-ink-3">{net > 0n ? "is owed" : net < 0n ? "owes" : ""}</div>
              </div>
            </div>
          );
        })}
      </section>

      {debts.length > 0 && (
        <section className="rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70">
          <h2 className="display text-2xl font-bold">To settle up</h2>
          <ul className="mt-3 divide-y divide-line">
            {debts.map((d) => (
              <li key={`${d.from}-${d.to}`} className="flex items-center justify-between gap-3 py-3">
                <span className="text-[15px]">
                  <strong>{label(d.from)}</strong> {d.from === viewerId ? "pay" : "pays"} <strong>{label(d.to)}</strong>
                </span>
                <span className="flex items-center gap-3">
                  <Money value={toPaise(d.amount)} className="font-semibold" />
                  {canAdd && (
                    <Button size="sm" variant="secondary" onClick={() => setRepaying(d)}>
                      Settle
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Timeline */}
      <section className="flex flex-col gap-3">
        <h2 className="display text-[1.6rem] font-bold sm:text-3xl">Activity</h2>
        {items.length === 0 ? (
          <p className="rounded-[var(--radius-card)] border-2 border-dashed border-line p-8 text-ink-2">
            No expenses yet. Add the first one: who paid, how much, and how to split it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((it) => {
              if (it.type === "expense") {
                const e = it.e;
                const fx = viewerId ? expenseEffect(e, viewerId) : null;
                const payersText = e.payers.map((p) => `${label(p.participant_id)} paid ${formatINR(toPaise(p.amount_paid))}`).join(", ");
                return (
                  <li key={e.id}>
                    <button type="button" onClick={() => setSelected(it)} className="flex w-full items-center gap-3 rounded-3xl bg-surface p-4 text-left ring-1 ring-inset ring-line/70 hover:bg-white">
                      <span className="flex size-12 shrink-0 flex-col items-center justify-center rounded-2xl bg-sunken text-[11px] font-semibold uppercase leading-tight">
                        {formatDateShort(e.txn_date, today).split(" ").map((x) => (
                          <span key={x}>{x}</span>
                        ))}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate font-semibold", e.status === "void" && "line-through opacity-50")}>{e.description}</span>
                        <span className="block truncate text-[13px] text-ink-3">{payersText}</span>
                      </span>
                      <span className="text-right">
                        {e.status === "void" ? (
                          <Badge>{e.void_reason === "Corrected" ? "corrected" : "void"}</Badge>
                        ) : fx && fx.effect !== 0n ? (
                          <>
                            <span className="block text-[12px] text-ink-3">{fx.effect > 0n ? "you lent" : "you borrowed"}</span>
                            <Money value={fx.effect > 0n ? fx.effect : -fx.effect} tone={fx.effect > 0n ? "in" : "out"} className="font-semibold" />
                          </>
                        ) : (
                          <>
                            <span className="block text-[12px] text-ink-3">{fx ? "no balance" : "total"}</span>
                            <Money value={toPaise(e.total_amount)} className="font-semibold" />
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                );
              }
              const s = it.s;
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => setSelected(it)} className="flex w-full items-center gap-3 rounded-3xl bg-tea/10 p-4 text-left ring-1 ring-inset ring-tea/30 hover:bg-tea/15">
                    <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-tea text-seashell">
                      <HandCoins className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate font-semibold", s.status === "void" && "line-through opacity-50")}>
                        {label(s.from_participant_id)} paid {label(s.to_participant_id)}
                      </span>
                      <span className="block text-[13px] text-ink-3">Repayment · {formatDateShort(s.txn_date, today)}</span>
                    </span>
                    {s.status === "void" ? <Badge>void</Badge> : <Money value={toPaise(s.amount)} className="font-semibold" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {history.length > 0 && <p className="text-[13px] text-ink-3">{history.length} repayments recorded. Repayments never count as shared expenses.</p>}
      </section>

      <SplitComposer
        key={correcting?.id ?? "new"}
        open={adding || Boolean(correcting)}
        onClose={() => {
          setAdding(false);
          setCorrecting(null);
        }}
        ledgerId={ledger.id}
        people={participants.map((p) => ({ id: p.id, name: p.name, isViewer: p.isViewer }))}
        today={today}
        correcting={correcting}
      />
      <RepaymentSheet
        key={repaying ? `${repaying.from}-${repaying.to}` : "closed"}
        open={Boolean(repaying)}
        onClose={() => setRepaying(null)}
        ledgerId={ledger.id}
        people={participants}
        debts={debts}
        initial={repaying}
        today={today}
        viewerId={viewerId}
      />
      <ItemSheet
        item={selected}
        onClose={() => setSelected(null)}
        label={label}
        names={names}
        viewerId={viewerId}
        canEdit={selected ? canEdit(selected.type === "expense" ? selected.e.created_by : selected.s.created_by) : false}
        ledgerId={ledger.id}
        onCorrect={(e) => {
          setSelected(null);
          setCorrecting(e);
        }}
      />
      {access.canManage && <ShareSheet open={share} onClose={() => setShare(false)} ledgerId={ledger.id} ledgerName={ledger.name} taxation={false} />}
    </div>
  );
}

function RepaymentSheet({
  open,
  onClose,
  ledgerId,
  people,
  debts,
  initial,
  today,
  viewerId,
}: {
  open: boolean;
  onClose: () => void;
  ledgerId: string;
  people: P[];
  debts: { from: string; to: string; amount: string }[];
  initial: { from: string; to: string; amount: string } | null;
  today: string;
  viewerId: string | null;
}) {
  const router = useRouter();
  const [from, setFrom] = useState(initial?.from ?? "");
  const [to, setTo] = useState(initial?.to ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [date, setDate] = useState(today);
  const [mode, setMode] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [key, setKey] = useState(newKey);

  const fromNet = toPaise(people.find((p) => p.id === from)?.net ?? "0");
  const toNet = toPaise(people.find((p) => p.id === to)?.net ?? "0");
  const max = fromNet < 0n && toNet > 0n ? (-fromNet < toNet ? -fromNet : toNet) : 0n;
  const value = tryPaise(amount);
  const over = value !== null && value > max;
  const name = (id: string) => (id === viewerId ? "You" : people.find((p) => p.id === id)?.name);

  const submit = () =>
    start(async () => {
      setError(null);
      const res = await recordRepayment({ ledger_id: ledgerId, from_participant_id: from, to_participant_id: to, amount, txn_date: date, payment_mode: mode as "cash", reference_no: reference, idempotency_key: key });
      if (!res.ok) return setError(res.error);
      toast.success(res.message ?? "Repayment recorded");
      setKey(newKey());
      router.refresh();
      onClose();
    });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Record repayment"
      description="Money paid back between two people. The original expenses stay as they are."
      footer={
        <Button size="lg" className="w-full" disabled={pending || !value || over || from === to} onClick={submit}>
          {pending ? "Saving…" : `Record ${value ? formatINR(value) : ""} repayment`}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Who paid">
            {(p) => (
              <Select {...p} value={from} onChange={(e) => setFrom(e.target.value)}>
                {people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {name(x.id)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Who received">
            {(p) => (
              <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
                {people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {name(x.id)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Amount" hint={max > 0n ? `Up to ${formatINR(max)} is outstanding between them` : "Nothing is outstanding between these two"} error={over ? `That is more than the ${formatINR(max)} outstanding` : undefined}>
          {(p) => <MoneyInput {...p} big value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        {debts.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {debts.map((d) => (
              <button
                key={`${d.from}${d.to}`}
                type="button"
                onClick={() => {
                  setFrom(d.from);
                  setTo(d.to);
                  setAmount(d.amount);
                }}
                className="rounded-full bg-sunken px-3 py-2 text-sm"
              >
                {name(d.from)} → {name(d.to)} {formatINR(toPaise(d.amount))}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">{(p) => <DateInput {...p} value={date} onChange={setDate} />}</Field>
          <Field label="Mode" optional>
            {(p) => (
              <Select {...p} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="">Not set</option>
                {PAYMENT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reference" optional className="col-span-2">
            {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UPI ref" maxLength={80} />}
          </Field>
        </div>
        {error && (
          <p role="alert" className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}

function ItemSheet({
  item,
  onClose,
  label,
  names,
  viewerId,
  canEdit,
  ledgerId,
  onCorrect,
}: {
  item: Item | null;
  onClose: () => void;
  label: (id: string) => string;
  names: Record<string, string>;
  viewerId: string | null;
  canEdit: boolean;
  ledgerId: string;
  onCorrect: (e: SharedExpense) => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [pending, start] = useTransition();
  if (!item) return <Sheet open={false} onClose={onClose} title="">{null}</Sheet>;
  const isExpense = item.type === "expense";
  const status = isExpense ? item.e.status : item.s.status;
  const createdBy = isExpense ? item.e.created_by : item.s.created_by;
  const createdAt = isExpense ? item.e.created_at : item.s.created_at;

  const doVoid = () =>
    start(async () => {
      const res = isExpense ? await voidSharedExpense(item.e.id, ledgerId, reason) : await voidRepayment(item.s.id, ledgerId, reason);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Voided");
      setVoiding(false);
      setReason("");
      router.refresh();
      onClose();
    });

  return (
    <Sheet open onClose={onClose} title={isExpense ? item.e.description : "Repayment"} description={formatDate(item.date)}>
      <div className="flex flex-col gap-5">
        <Amount value={toPaise(isExpense ? item.e.total_amount : item.s.amount)} size="xl" className={status === "void" ? "line-through opacity-50" : ""} />
        {isExpense ? (
          <>
            <table className="w-full text-[15px]">
              <caption className="sr-only">Who paid and each person&apos;s share</caption>
              <thead>
                <tr className="text-left text-[13px] text-ink-3">
                  <th scope="col" className="pb-2 font-medium">Person</th>
                  <th scope="col" className="pb-2 text-right font-medium">Paid</th>
                  <th scope="col" className="pb-2 text-right font-medium">Share</th>
                  <th scope="col" className="pb-2 text-right font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {[...new Set([...item.e.payers.map((p) => p.participant_id), ...item.e.shares.map((s) => s.participant_id)])].map((id) => {
                  const fx = expenseEffect(item.e, id);
                  return (
                    <tr key={id}>
                      <td className="py-2.5 font-medium">{label(id)}</td>
                      <td className="num py-2.5 text-right">{fx.paid ? formatINR(fx.paid) : "—"}</td>
                      <td className="num py-2.5 text-right">{formatINR(fx.share)}</td>
                      <td className={cn("num py-2.5 text-right font-semibold", fx.effect > 0n ? "text-in" : fx.effect < 0n ? "text-out" : "text-ink-3")}>
                        {fx.effect === 0n ? "even" : `${fx.effect > 0n ? "lent" : "owes"} ${formatINR(fx.effect > 0n ? fx.effect : -fx.effect)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[13px] text-ink-3">
              Split {item.e.split_method === "equal" ? "equally" : item.e.split_method === "exact" ? "by exact amounts" : item.e.split_method === "percent" ? "by percentage" : "by shares"}.
              {viewerId && " Everyone sees this same record from their own side."}
            </p>
          </>
        ) : (
          <p className="text-[15px]">
            <strong>{label(item.s.from_participant_id)}</strong> paid <strong>{label(item.s.to_participant_id)}</strong>. This reduces what is owed between
            them and does not change any expense.
          </p>
        )}
        <p className="text-[13px] text-ink-3">
          Added by {names[createdBy] ?? "someone"} · {formatDateTime(createdAt)}
          {status === "void" && ` · ${isExpense && item.e.void_reason === "Corrected" ? "replaced by a correction" : `voided: ${isExpense ? item.e.void_reason : item.s.void_reason}`}`}
        </p>
        {canEdit && status === "posted" && !voiding && (
          <div className="grid grid-cols-2 gap-2">
            {isExpense && <Button onClick={() => onCorrect(item.e)}>Correct</Button>}
            <Button variant="secondary" onClick={() => setVoiding(true)} className={isExpense ? "" : "col-span-2"}>
              Void
            </Button>
          </div>
        )}
        {voiding && (
          <div className="flex flex-col gap-3 rounded-[24px] bg-sunken p-4">
            <p className="text-[15px]">Voiding keeps it in the history and removes it from everyone&apos;s balance.</p>
            <Field label="Reason">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={300} />}</Field>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setVoiding(false)}>
                Cancel
              </Button>
              <Button variant="danger" className="flex-1" disabled={pending || !reason.trim()} onClick={doVoid}>
                Void
              </Button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
