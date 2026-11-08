"use client";
import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { ClientPicker, type ClientOption } from "@/components/app/client-picker";
import { Avatar } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { computeShares, type SplitMethod } from "@/lib/domain/split";
import { formatINR, MoneyError, tryPaise } from "@/lib/domain/money";
import { cn } from "@/lib/cn";

const ME = "me";
const METHODS: { value: SplitMethod; label: string }[] = [
  { value: "equal", label: "Equally" },
  { value: "exact", label: "Exact" },
  { value: "percent", label: "%" },
  { value: "shares", label: "Shares" },
];

/**
 * "With whom" on an expense. Empty, it stays out of the way and the expense is simply yours.
 * With people chosen, each person's part lands on their client page; no ledger is created by hand.
 * The form posts the choices, and the server works out the amounts again before saving.
 */
export function SplitWith({
  clients,
  amount,
  initial,
  onChange,
  fixedPayer = false,
  onShares,
}: {
  clients: ClientOption[];
  amount: string;
  initial?: string;
  onChange: (state: { splitting: boolean; theyPaid: boolean }) => void;
  /** Money out of your own wallet: you paid, so "they paid" is not offered. */
  fixedPayer?: boolean;
  /** The worked-out shares, for a live preview. */
  onShares?: (shares: { you: bigint; people: { name: string; amount: bigint }[] } | null) => void;
}) {
  const [people, setPeople] = useState<string[]>(initial ? [initial] : []);
  const [picking, setPicking] = useState(false);
  const [added, setAdded] = useState<ClientOption[]>([]);
  const [method, setMethod] = useState<SplitMethod>("equal");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [includeMe, setIncludeMe] = useState(true);
  const [paidBy, setPaidBy] = useState<string>(ME);

  const all = useMemo(() => [...clients, ...added], [clients, added]);
  const nameOf = (id: string) => all.find((c) => c.id === id)?.name ?? "Someone";
  const first = (id: string) => nameOf(id).split(" ")[0];
  const solo = people.length === 1;
  const payer = solo && paidBy === people[0] ? paidBy : ME;
  const sharing = [...(includeMe ? [ME] : []), ...people];

  const total = tryPaise(amount);
  const { shares, problem } = useMemo(() => {
    if (!people.length || total === null || total <= 0n) return { shares: null, problem: null };
    try {
      const list = computeShares(
        total,
        method,
        sharing.map((id) => ({ participantId: id, input: method === "equal" ? undefined : inputs[id] || (method === "shares" ? "1" : "") })),
      );
      return { shares: new Map(list.map((s) => [s.participantId, s.amount])), problem: null };
    } catch (e) {
      return { shares: null, problem: e instanceof MoneyError ? e.message : "Check the split" };
    }
    // sharing is derived from people and includeMe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, method, inputs, people, includeMe]);

  useEffect(() => {
    onShares?.(shares ? { you: shares.get(ME) ?? 0n, people: people.map((id) => ({ name: nameOf(id), amount: shares.get(id) ?? 0n })) } : null);
    // nameOf only reads the client list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shares, people, onShares]);

  const update = (next: string[]) => {
    setPeople(next);
    const stillPaid = next.length === 1 && paidBy === next[0];
    if (!stillPaid) setPaidBy(ME);
    onChange({ splitting: next.length > 0, theyPaid: stillPaid });
  };
  const choosePayer = (id: string) => {
    setPaidBy(id);
    onChange({ splitting: true, theyPaid: id !== ME });
  };

  const summary: { key: string; text: string }[] = [];
  if (shares) {
    if (payer === ME) {
      for (const id of people) {
        const a = shares.get(id) ?? 0n;
        if (a > 0n) summary.push({ key: id, text: `${first(id)} owes you ${formatINR(a)}` });
      }
    } else {
      const a = shares.get(ME) ?? 0n;
      if (a > 0n) summary.push({ key: "you", text: `You owe ${first(payer)} ${formatINR(a)}` });
    }
    const mine = shares.get(ME) ?? 0n;
    if (mine > 0n) summary.push({ key: "mine", text: `Your expense ${formatINR(mine)}` });
  }

  const payload = people.length
    ? JSON.stringify({
        people: people.map((id) => ({ contractor_id: id, input: inputs[id] })),
        include_me: includeMe,
        your_input: inputs[ME],
        method,
        paid_by: payer === ME ? null : payer,
      })
    : "";

  return (
    <section aria-label="With whom" className="flex flex-col gap-4 rounded-[24px] bg-sunken p-4 sm:p-5">
      <input type="hidden" name="split" value={payload} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold">With whom</div>
          <div className="text-[13px] text-ink-2">{people.length ? "Each share goes straight to their client page" : "Just you. Add people to split it."}</div>
        </div>
        <Button variant={people.length ? "ghost" : "secondary"} size="sm" onClick={() => setPicking(!picking)}>
          {picking ? "Done" : <><Plus className="size-4" /> {people.length ? "Add" : "Split"}</>}
        </Button>
      </div>

      {people.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {people.map((id) => (
            <li key={id} className="inline-flex h-11 items-center gap-2 rounded-full bg-white pl-1.5 pr-1 ring-1 ring-inset ring-line">
              <Avatar name={nameOf(id)} className="size-8" tone="sunken" />
              <span className="max-w-40 truncate text-sm font-medium">{nameOf(id)}</span>
              <button
                type="button"
                aria-label={`Remove ${nameOf(id)}`}
                onClick={() => update(people.filter((p) => p !== id))}
                className="inline-flex size-9 items-center justify-center rounded-full hover:bg-sunken"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {picking && (
        <ClientPicker
          clients={clients}
          selected={people}
          onChange={(ids, newOne) => {
            if (newOne) setAdded((a) => [...a, newOne]);
            update(ids);
          }}
        />
      )}

      {people.length > 0 && (
        <>
          {solo && !fixedPayer ? (
            <Segmented
              label="Who paid"
              value={payer}
              onChange={choosePayer}
              options={[
                { value: ME, label: "You paid" },
                { value: people[0], label: `${first(people[0])} paid` },
              ]}
            />
          ) : (
            <p className="text-[13px] text-ink-2">
              {fixedPayer ? "You paid from your wallet; each share is owed back to you." : "You paid. If someone else paid for a group, they are owed rather than you, so use a shared account for that."}
            </p>
          )}
          <Segmented label="How to split" value={method} onChange={setMethod} options={METHODS} />
          <ul className="flex flex-col divide-y divide-line rounded-2xl bg-white px-3 ring-1 ring-inset ring-line">
            <Row
              name="You"
              on={includeMe}
              onToggle={() => setIncludeMe(!includeMe)}
              method={method}
              value={inputs[ME] ?? ""}
              onInput={(v) => setInputs({ ...inputs, [ME]: v })}
              amount={shares?.get(ME) ?? null}
            />
            {people.map((id) => (
              <Row
                key={id}
                name={nameOf(id)}
                on
                method={method}
                value={inputs[id] ?? ""}
                onInput={(v) => setInputs({ ...inputs, [id]: v })}
                amount={shares?.get(id) ?? null}
              />
            ))}
          </ul>
          {problem && <p className="text-[13px] font-medium text-out">{problem}</p>}
          {summary.length > 0 && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 rounded-2xl bg-ink px-4 py-3 text-sm font-medium text-surface">
              {summary.map((s) => (
                <li key={s.key} className="num">{s.text}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Row({
  name,
  on,
  onToggle,
  method,
  value,
  onInput,
  amount,
}: {
  name: string;
  on: boolean;
  onToggle?: () => void;
  method: SplitMethod;
  value: string;
  onInput: (v: string) => void;
  amount: bigint | null;
}) {
  return (
    <li className="flex min-h-14 items-center gap-3 py-2">
      {onToggle ? (
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
          <input type="checkbox" checked={on} onChange={onToggle} className="size-5 accent-[var(--color-ink)]" />
          <span className={cn("truncate font-medium", !on && "text-ink-3")}>{name}</span>
        </label>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      )}
      {on && method !== "equal" && (
        <Input
          aria-label={`${method === "exact" ? "Amount" : method === "percent" ? "Percent" : "Shares"} for ${name}`}
          inputMode="decimal"
          value={value}
          onChange={(e) => onInput(e.target.value)}
          placeholder={method === "exact" ? "₹0" : method === "percent" ? "%" : "1"}
          className="w-24 text-right"
        />
      )}
      <span className="num w-24 shrink-0 text-right font-semibold">{on ? (amount === null ? "—" : formatINR(amount)) : "Not sharing"}</span>
    </li>
  );
}
