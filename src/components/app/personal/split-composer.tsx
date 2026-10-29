"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sheet } from "@/components/ui/sheet";
import { Field, Input, MoneyInput, Select } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/bits";
import { saveSharedExpense } from "@/app/(app)/actions/records";
import { type SplitMethod, computeShares } from "@/lib/domain/split";
import { formatINR, sum, toDecimal, tryPaise } from "@/lib/domain/money";
import { PAYMENT_MODES, type SharedExpense } from "@/lib/types";
import { cn } from "@/lib/cn";

interface Person {
  id: string;
  name: string;
  isViewer: boolean;
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Shared expense entry with a live split preview. The preview uses the same split engine as the
 * server, which recomputes the shares before the database checks they add up to the total.
 */
/** "40.0000" → "40", "250.50" → "250.5": stored numbers shown the way people type them. */
const plain = (v: string) => (v.includes(".") ? v.replace(/\.?0+$/, "") : v);

export function SplitComposer({
  open,
  onClose,
  ledgerId,
  people,
  today,
  correcting,
}: {
  open: boolean;
  onClose: () => void;
  ledgerId: string;
  people: Person[];
  today: string;
  correcting?: SharedExpense | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const me = people.find((p) => p.isViewer) ?? people[0];
  // Remounted (key) per expense being corrected, so state starts from that record.
  const c = correcting ?? null;
  const [description, setDescription] = useState(c?.description ?? "");
  const [total, setTotal] = useState(c?.total_amount ?? "");
  const [date, setDate] = useState(c?.txn_date ?? today);
  const [method, setMethod] = useState<SplitMethod>(c?.split_method ?? "equal");
  const [payerMode, setPayerMode] = useState<"single" | "multi">(c && c.payers.length > 1 ? "multi" : "single");
  const [payer, setPayer] = useState(c?.payers.length === 1 ? c.payers[0].participant_id : (me?.id ?? ""));
  const [paid, setPaid] = useState<Record<string, string>>(
    c && c.payers.length > 1 ? Object.fromEntries(c.payers.map((p) => [p.participant_id, p.amount_paid])) : {},
  );
  const [included, setIncluded] = useState<Record<string, boolean>>(
    Object.fromEntries(people.map((p) => [p.id, c ? c.shares.some((s) => s.participant_id === p.id) : true])),
  );
  const [inputs, setInputs] = useState<Record<string, string>>(
    c ? Object.fromEntries(c.shares.map((s) => [s.participant_id, plain(c.split_method === "exact" ? s.share_amount : (s.share_input ?? ""))])) : {},
  );
  const [category, setCategory] = useState(c?.category ?? "");
  const [paymentMode, setPaymentMode] = useState<string>(c?.payment_mode ?? "");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);

  const totalPaise = tryPaise(total);
  const sharing = people.filter((p) => included[p.id]);

  const preview = useMemo(() => {
    if (!totalPaise || totalPaise <= 0n || sharing.length === 0) return { shares: null, error: null as string | null };
    try {
      const shares = computeShares(
        totalPaise,
        method,
        sharing.map((p) => ({ participantId: p.id, input: method === "equal" ? undefined : inputs[p.id] || (method === "shares" ? "1" : "") })),
      );
      return { shares: new Map(shares.map((s) => [s.participantId, s.amount])), error: null };
    } catch (e) {
      return { shares: null, error: (e as Error).message };
    }
  }, [totalPaise, method, sharing, inputs]);

  const payers =
    payerMode === "single"
      ? totalPaise
        ? [{ participant_id: payer, amount: toDecimal(totalPaise) }]
        : []
      : people.filter((p) => tryPaise(paid[p.id]) && tryPaise(paid[p.id])! > 0n).map((p) => ({ participant_id: p.id, amount: toDecimal(tryPaise(paid[p.id])!) }));
  const paidTotal = sum(payers.map((p) => tryPaise(p.amount) ?? 0n));
  const paidMismatch = totalPaise !== null && payerMode === "multi" && paidTotal !== totalPaise;

  const submit = () => {
    setError(null);
    start(async () => {
      const res = await saveSharedExpense(correcting?.id ?? null, {
        ledger_id: ledgerId,
        txn_date: date,
        description,
        total_amount: total,
        split_method: method,
        category,
        payment_mode: paymentMode as "cash",
        payers,
        shares: sharing.map((p) => ({ participant_id: p.id, input: method === "equal" ? undefined : inputs[p.id] || (method === "shares" ? "1" : "") })),
        idempotency_key: correcting ? undefined : key,
      });
      if (!res.ok) {
        // The message also sits at the end of the form; a toast makes sure it is seen.
        setError(res.error);
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Saved");
      router.refresh();
      setDescription("");
      setTotal("");
      setInputs({});
      setPaid({});
      setKey(newKey());
      onClose();
    });
  };

  const name = (id: string) => (people.find((p) => p.id === id)?.isViewer ? "You" : people.find((p) => p.id === id)?.name);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={correcting ? "Correct expense" : "Add expense"}
      description={correcting ? "The original is kept in history, marked as corrected." : undefined}
      footer={
        <Button size="lg" className="w-full" disabled={pending || !preview.shares || paidMismatch || !description.trim()} onClick={submit}>
          {pending ? "Saving…" : correcting ? "Save correction" : "Add expense"}
        </Button>
      }
    >
      <form
        className="flex flex-col gap-5 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="What was it for?">
          {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Dinner at Bademiya" maxLength={200} autoFocus />}
        </Field>
        <Field label="Total amount">
          {(p) => <MoneyInput {...p} big value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0" />}
        </Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-ink-2">Who paid?</legend>
          <Segmented
            label="Payers"
            value={payerMode}
            onChange={setPayerMode}
            options={[
              { value: "single", label: "One person" },
              { value: "multi", label: "Several people" },
            ]}
          />
          {payerMode === "single" ? (
            <div className="flex flex-wrap gap-2">
              {people.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={payer === p.id}
                  onClick={() => setPayer(p.id)}
                  className={cn(
                    "inline-flex h-12 items-center gap-2 rounded-full pl-1.5 pr-4 text-[15px] font-medium ring-1 ring-inset",
                    payer === p.id ? "bg-ink text-surface ring-ink" : "bg-white ring-line",
                  )}
                >
                  <Avatar name={p.name} className="size-9" tone={payer === p.id ? "light" : "sunken"} />
                  {p.isViewer ? "You" : p.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {people.map((p) => (
                <div key={p.id} className="flex items-center gap-3">
                  <Avatar name={p.name} />
                  <label htmlFor={`paid-${p.id}`} className="w-24 truncate text-[15px] font-medium">
                    {p.isViewer ? "You" : p.name}
                  </label>
                  <MoneyInput id={`paid-${p.id}`} value={paid[p.id] ?? ""} onChange={(e) => setPaid({ ...paid, [p.id]: e.target.value })} placeholder="0" />
                </div>
              ))}
              {paidMismatch && (
                <p className="text-[13px] font-medium text-out">
                  Paid adds up to {formatINR(paidTotal)}; the total is {formatINR(totalPaise!)}.
                </p>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-ink-2">Split</legend>
          <Segmented
            label="Split method"
            value={method}
            onChange={setMethod}
            options={[
              { value: "equal", label: "Equally" },
              { value: "exact", label: "Amounts" },
              { value: "percent", label: "%" },
              { value: "shares", label: "Shares" },
            ]}
          />
          <ul className="flex flex-col gap-2">
            {people.map((p) => {
              const share = preview.shares?.get(p.id);
              return (
                <li key={p.id} className={cn("flex items-center gap-3 rounded-2xl bg-white p-2 pr-3 ring-1 ring-inset ring-line", !included[p.id] && "opacity-55")}>
                  <input
                    type="checkbox"
                    aria-label={`Include ${p.name}`}
                    checked={included[p.id] ?? false}
                    onChange={(e) => setIncluded({ ...included, [p.id]: e.target.checked })}
                    className="ml-2 size-5 accent-[#1d1d1b]"
                  />
                  <Avatar name={p.name} className="size-9" />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.isViewer ? "You" : p.name}</span>
                  {method !== "equal" && included[p.id] && (
                    <label className="sr-only" htmlFor={`share-${p.id}`}>
                      {method === "exact" ? "Amount" : method === "percent" ? "Percent" : "Shares"} for {p.name}
                    </label>
                  )}
                  {method !== "equal" && included[p.id] && (
                    <input
                      id={`share-${p.id}`}
                      inputMode="decimal"
                      value={inputs[p.id] ?? ""}
                      placeholder={method === "exact" ? "₹0" : method === "percent" ? "%" : "1"}
                      onChange={(e) => setInputs({ ...inputs, [p.id]: e.target.value })}
                      className="num h-10 w-20 rounded-xl bg-canvas px-2 text-right text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink"
                    />
                  )}
                  <span className="num w-24 text-right text-[15px] font-semibold">{share !== undefined ? formatINR(share) : "—"}</span>
                </li>
              );
            })}
          </ul>
          {preview.error && <p className="text-[13px] font-medium text-out">{preview.error}</p>}
        </fieldset>

        {/* Live outcome from each person's side */}
        {preview.shares && !paidMismatch && (
          <section aria-label="Who owes whom" className="rounded-[24px] bg-ink p-4 text-seashell">
            <h3 className="text-sm font-medium opacity-70">After this expense</h3>
            <ul className="mt-2 space-y-1.5">
              {people.map((p) => {
                const paidBy = sum(payers.filter((x) => x.participant_id === p.id).map((x) => tryPaise(x.amount) ?? 0n));
                const effect = paidBy - (preview.shares!.get(p.id) ?? 0n);
                if (effect === 0n) return null;
                return (
                  <li key={p.id} className="flex justify-between gap-3 text-[15px]">
                    <span>{effect > 0n ? `${name(p.id)} ${p.isViewer ? "are" : "is"} owed` : `${name(p.id)} ${p.isViewer ? "owe" : "owes"}`}</span>
                    <span className={cn("num font-semibold", effect > 0n ? "text-mustard" : "text-pink")}>{formatINR(effect > 0n ? effect : -effect)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">{(p) => <DateInput {...p} value={date} onChange={setDate} />}</Field>
          <Field label="Category" optional>
            {(p) => <Input {...p} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Food" maxLength={60} />}
          </Field>
          <Field label="Paid by" optional className="col-span-2">
            {(p) => (
              <Select {...p} value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
                <option value="">Not set</option>
                {PAYMENT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {error && (
          <p role="alert" className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
