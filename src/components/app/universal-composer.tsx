"use client";
import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addCategory, recordClientPayment, saveExpense } from "@/app/(app)/actions/records";
import { postEntry } from "@/app/(app)/actions/ledgers";
import { recordPayment } from "@/app/(app)/actions/invoices";
import { recordClientBill, recordPaidForMe, recordPartyTransfer, recordTransfer } from "@/app/(app)/actions/entries";
import { SplitWith } from "@/components/app/split-with";
import type { ClientOption } from "@/components/app/client-picker";
import type { WalletOption } from "@/components/app/wallet-select";
import { Button } from "@/components/ui/button";
import { Field, Input, MoneyInput, Select } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Segmented } from "@/components/ui/segmented";
import { formatINR, toDecimal, tryPaise } from "@/lib/domain/money";
import { cn } from "@/lib/cn";

export type Tab = "paid" | "received" | "book" | "transfer";
type Sub = "expense" | "person" | "debtor" | "borrowed" | "income" | "bill" | "paidForMe" | "party" | "transfer";

const TABS: { value: Tab; label: string }[] = [
  { value: "paid", label: "Paid" },
  { value: "received", label: "Received" },
  { value: "book", label: "Book entry" },
  { value: "transfer", label: "Transfer" },
];

const SUBS: Record<Tab, { value: Sub; label: string; hint: string }[]> = {
  paid: [
    { value: "expense", label: "My expense", hint: "Your cost. Split it and only your share is a cost; the rest is owed back." },
    { value: "person", label: "Paid to a person", hint: "Paying back what you owe, lending, or paying on their behalf. Never a cost." },
  ],
  received: [
    { value: "debtor", label: "From someone who owes you", hint: "Settles what they owe. Not new income: it was counted when billed." },
    { value: "borrowed", label: "Borrowed or an advance", hint: "You owe it back. Not income." },
    { value: "income", label: "Direct income", hint: "Earned and paid on the spot, like a cash sale." },
  ],
  book: [
    { value: "bill", label: "Bill a client", hint: "Income now, owed until they pay. No money moves. For GST invoices, use Invoices." },
    { value: "paidForMe", label: "Someone paid for me", hint: "A supplier's bill on credit, or a friend who paid. Your share is your cost, owed to them." },
    { value: "party", label: "Settle between two people", hint: "One person pays another for you. Both balances move; none of your money does." },
  ],
  transfer: [{ value: "transfer", label: "Between wallets", hint: "Cash to bank or bank to cash. Neither income nor cost." }],
};

interface Line {
  side: "Dr" | "Cr";
  account: string;
  note: string;
  amount: bigint;
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * One screen for every entry. Each choice maps to one database call that writes both sides
 * together, and the panel beside it shows exactly what will be written: which accounts are
 * debited and credited, what happens to your wallets, to each person, and to profit.
 */
export function UniversalComposer({
  clients,
  wallets,
  categories,
  invoices,
  today,
  initialTab = "paid",
  initialSub,
  withClient,
  lockTab = false,
}: {
  clients: ClientOption[];
  wallets: WalletOption[];
  categories: { id: string; name: string }[];
  invoices: { id: string; no: string; contractor_id: string; balance: string }[];
  today: string;
  initialTab?: Tab;
  initialSub?: Sub;
  withClient?: string;
  /** Opened as one kind of entry (Paid, Received, Book entry or Transfer): no switching between kinds. */
  lockTab?: boolean;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [key, setKey] = useState(newKey);
  const bankFirst = wallets.find((w) => w.kind === "bank")?.id ?? wallets[0]?.id ?? "";

  const [tab, setTab] = useState<Tab>(initialTab);
  const [sub, setSub] = useState<Sub>(initialSub && SUBS[initialTab].some((s) => s.value === initialSub) ? initialSub : SUBS[initialTab][0].value);
  const [amount, setAmount] = useState("");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today);
  const [wallet, setWallet] = useState(bankFirst);
  const [toWallet, setToWallet] = useState(wallets.find((w) => w.id !== bankFirst)?.id ?? "");
  const [person, setPerson] = useState(withClient ?? "");
  const [person2, setPerson2] = useState("");
  const [invoice, setInvoice] = useState("");
  const [yourShare, setYourShare] = useState("");
  const [cats, setCats] = useState(categories);
  const [category, setCategory] = useState(categories[0]?.id ?? "");
  const [newCat, setNewCat] = useState("");
  const [shares, setShares] = useState<{ you: bigint; people: { name: string; amount: bigint }[] } | null>(null);
  const [splitting, setSplitting] = useState(Boolean(withClient));
  const [error, setError] = useState<string | null>(null);
  const onShares = useCallback((s: typeof shares) => setShares(s), []);

  const chooseTab = (t: Tab) => {
    setTab(t);
    setSub(SUBS[t][0].value);
    setError(null);
  };
  const value = tryPaise(amount);
  const nameOf = (id: string) => clients.find((c) => c.id === id)?.name ?? "";
  const walletName = (id: string) => wallets.find((w) => w.id === id)?.name ?? "a wallet";
  const catName = cats.find((c) => c.id === category)?.name ?? "Expense";
  const theirInvoices = invoices.filter((i) => i.contractor_id === person);
  const needsWallet = tab === "paid" || tab === "received";
  const yours = tryPaise(yourShare || amount);

  // What will be written, as double entry.
  const lines: Line[] = useMemo(() => {
    if (value === null || value <= 0n) return [];
    const A = value;
    const who = nameOf(person) || "the person";
    const w = walletName(wallet);
    switch (sub) {
      case "expense":
        if (splitting && shares) {
          return [
            ...(shares.you > 0n ? [{ side: "Dr" as const, account: `${catName} (your share)`, note: "Cost in Profit & Loss", amount: shares.you }] : []),
            ...shares.people.filter((p) => p.amount > 0n).map((p) => ({ side: "Dr" as const, account: p.name, note: "Owes you their share", amount: p.amount })),
            { side: "Cr", account: w, note: "Money out", amount: A },
          ];
        }
        return [
          { side: "Dr", account: catName, note: "Cost in Profit & Loss", amount: A },
          { side: "Cr", account: w, note: "Money out", amount: A },
        ];
      case "person":
        return [
          { side: "Dr", account: who, note: "Owes you more, or you owe them less", amount: A },
          { side: "Cr", account: w, note: "Money out", amount: A },
        ];
      case "debtor":
      case "borrowed":
        return [
          { side: "Dr", account: w, note: "Money in", amount: A },
          { side: "Cr", account: invoice ? `${who} · invoice` : who, note: sub === "debtor" ? "Owes you less" : "You owe them", amount: A },
        ];
      case "income":
        return [
          { side: "Dr", account: w, note: "Money in", amount: A },
          { side: "Cr", account: "Income", note: "Profit & Loss", amount: A },
        ];
      case "bill":
        return [
          { side: "Dr", account: who, note: "Owes you", amount: A },
          { side: "Cr", account: "Income", note: "Profit & Loss, no money moved", amount: A },
        ];
      case "paidForMe": {
        const y = yours !== null && yours > 0n && yours <= A ? yours : A;
        return [
          { side: "Dr", account: catName, note: y === A ? "Cost in Profit & Loss" : `Your share of ${formatINR(A)}`, amount: y },
          { side: "Cr", account: who, note: "You owe them", amount: y },
        ];
      }
      case "party":
        return [
          { side: "Dr", account: nameOf(person2) || "Who was paid", note: "You owe them less", amount: A },
          { side: "Cr", account: who, note: "Owes you less", amount: A },
        ];
      case "transfer":
        return [
          { side: "Dr", account: walletName(toWallet), note: "Money in", amount: A },
          { side: "Cr", account: w, note: "Money out", amount: A },
        ];
    }
    // nameOf and walletName read props only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, sub, splitting, shares, catName, person, person2, wallet, toWallet, invoice, yours]);

  const debit = lines.filter((l) => l.side === "Dr").reduce((t, l) => t + l.amount, 0n);
  const credit = lines.filter((l) => l.side === "Cr").reduce((t, l) => t + l.amount, 0n);
  const profitEffect = sub === "income" || sub === "bill" ? (value ?? 0n) : sub === "expense" ? -(splitting && shares ? shares.you : (value ?? 0n)) : sub === "paidForMe" ? -(lines[0]?.amount ?? 0n) : 0n;
  const walletEffect = sub === "expense" || sub === "person" ? -(value ?? 0n) : sub === "debtor" || sub === "borrowed" || sub === "income" ? (value ?? 0n) : 0n;

  const done = (res: { ok: boolean; error?: string; message?: string }) => {
    if (!res.ok) return setError(res.error ?? "Could not save");
    toast.success(res.message ?? "Saved");
    setKey(newKey());
    setAmount("");
    setTitle("");
    setYourShare("");
    router.refresh();
    if (withClient) router.push(`/contractors/${withClient}`);
  };

  const submit = () =>
    start(async () => {
      setError(null);
      if (value === null || value <= 0n) return setError("Enter an amount");
      if (needsWallet && !wallet) return setError("Choose a wallet");
      const base = { amount: toDecimal(value), idempotency_key: key };
      switch (sub) {
        case "expense": {
          const fd = new FormData(form.current!);
          fd.set("amount", base.amount);
          fd.set("title", title || catName);
          fd.set("expense_date", date);
          fd.set("category_id", category);
          fd.set("ledger_id", wallet);
          fd.set("idempotency_key", key);
          return done(await saveExpense(null, null, fd));
        }
        case "person":
        case "debtor":
        case "borrowed":
          if (!person) return setError("Choose who");
          if (sub === "debtor" && invoice) {
            return done(await recordPayment(invoice, { amount: base.amount, paid_on: date, mode: "", reference: "", notes: title, idempotency_key: key, wallet_ledger_id: wallet }));
          }
          return done(
            await recordClientPayment({ ...base, contractor_id: person, kind: sub === "person" ? "paid" : "received", they_owe: false, txn_date: date, ledger_id: wallet, notes: title }),
          );
        case "income":
          return done(await postEntry({ ...base, ledger_id: wallet, kind: "regular", direction: "in", txn_date: date, description: title || "Income", counterparty: nameOf(person) || undefined, nature: "income", status: "posted" }));
        case "bill":
          if (!person) return setError("Choose the client");
          return done(await recordClientBill({ ...base, contractor_id: person, txn_date: date, description: title || undefined }));
        case "paidForMe":
          if (!person) return setError("Choose who paid");
          return done(await recordPaidForMe({ ...base, contractor_id: person, your_share: toDecimal(lines[0]?.amount ?? value), category_id: category, title: title || catName, expense_date: date }));
        case "party":
          if (!person || !person2) return setError("Choose both people");
          return done(await recordPartyTransfer({ ...base, from_contractor_id: person, to_contractor_id: person2, txn_date: date, notes: title || undefined }));
        case "transfer":
          return done(await recordTransfer({ ...base, from_ledger_id: wallet, to_ledger_id: toWallet, txn_date: date, description: title || undefined }));
      }
    });

  const people = (label: string, valueId: string, set: (id: string) => void, exclude?: string) => (
    <Field label={label}>
      {(p) => (
        <Select {...p} value={valueId} onChange={(e) => set(e.target.value)}>
          <option value="">Choose</option>
          {clients
            .filter((c) => c.id !== exclude)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
      )}
    </Field>
  );
  const walletField = (label: string, valueId: string, set: (id: string) => void, exclude?: string) => (
    <Field label={label}>
      {(p) => (
        <Select {...p} value={valueId} onChange={(e) => set(e.target.value)} required>
          {wallets
            .filter((w) => w.id !== exclude)
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
        </Select>
      )}
    </Field>
  );
  const categoryField = (
    <div className="flex flex-col gap-2">
      <Field label="Category">
        {(p) => (
          <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex gap-2">
        <label htmlFor="uc-new-cat" className="sr-only">
          New category
        </label>
        <Input id="uc-new-cat" value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Add a category" maxLength={60} />
        <Button
          variant="secondary"
          disabled={!newCat.trim()}
          onClick={() =>
            start(async () => {
              const res = await addCategory(newCat);
              if (!res.ok) return void toast.error(res.error);
              setCats([...cats, { id: res.data!.id, name: newCat.trim() }]);
              setCategory(res.data!.id);
              setNewCat("");
            })
          }
        >
          Add
        </Button>
      </div>
    </div>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr] lg:items-start">
      <form ref={form} onSubmit={(e) => (e.preventDefault(), submit())} className="flex min-w-0 flex-col gap-5">
        {!lockTab && <Segmented label="Kind of entry" size="lg" value={tab} onChange={chooseTab} options={TABS} />}
        {SUBS[tab].length > 1 && (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What happened">
          {SUBS[tab].map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={sub === s.value}
              onClick={() => (setSub(s.value), setError(null))}
              className={cn("min-h-11 rounded-full px-4 text-[15px] font-medium ring-1 ring-inset", sub === s.value ? "bg-ink text-surface ring-ink" : "bg-surface ring-line hover:bg-white")}
            >
              {s.label}
            </button>
          ))}
        </div>
        )}
        <p className="-mt-2 text-[13px] text-ink-2">{SUBS[tab].find((s) => s.value === sub)?.hint}</p>

        <Field label="Amount">{(p) => <MoneyInput {...p} big value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus />}</Field>

        <div className="grid gap-4 sm:grid-cols-2">
          {needsWallet && walletField(tab === "paid" ? "Paid from" : "Received into", wallet, setWallet)}
          {sub === "transfer" && walletField("From", wallet, setWallet)}
          {sub === "transfer" && walletField("To", toWallet, setToWallet, wallet)}
          {(sub === "person" || sub === "debtor" || sub === "borrowed" || sub === "bill") && people(sub === "person" ? "Paid to" : sub === "bill" ? "Client" : "From", person, setPerson)}
          {sub === "income" && people("From (optional)", person, setPerson)}
          {sub === "paidForMe" && people("Who paid", person, setPerson)}
          {sub === "party" && people("Who paid (owed you)", person, setPerson)}
          {sub === "party" && people("Who received (you owed)", person2, setPerson2, person)}
          <Field label="Date">{(p) => <DateInput {...p} value={date} onChange={setDate} />}</Field>
        </div>

        {sub === "debtor" && theirInvoices.length > 0 && (
          <Field label="Against an invoice" optional hint="Marks the invoice paid too. Leave empty for a general payment.">
            {(p) => (
              <Select {...p} value={invoice} onChange={(e) => setInvoice(e.target.value)}>
                <option value="">No particular invoice</option>
                {theirInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.no} · {formatINR(BigInt(i.balance))} due
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {(sub === "expense" || sub === "paidForMe") && categoryField}
        {sub === "paidForMe" && (
          <Field label="Your share" optional hint="If they paid a group bill, enter just your part. Empty means all of it is yours.">
            {(p) => <MoneyInput {...p} value={yourShare} onChange={(e) => setYourShare(e.target.value)} placeholder={amount || "0"} />}
          </Field>
        )}

        <Field label={sub === "expense" || sub === "paidForMe" ? "What was it for?" : "Note"} optional>
          {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}
        </Field>

        {sub === "expense" && (
          <>
            <SplitWith clients={clients} amount={amount} initial={withClient} onChange={(s) => setSplitting(s.splitting)} fixedPayer onShares={onShares} />
            <Link href={withClient ? `/expenses/new?with=${withClient}` : "/expenses/new"} className="min-h-11 text-sm font-medium text-ink-2 underline underline-offset-4">
              Need GST, vendor or a bill number? Use the full expense form
            </Link>
          </>
        )}

        {error && <p className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">{error}</p>}
        <div className="sticky bottom-24 z-10 lg:bottom-4">
          <Button type="submit" size="lg" disabled={pending || !lines.length} className="w-full shadow-[0_12px_32px_rgb(29_29_27/0.22)]">
            {pending ? "Saving…" : value ? `Save ${formatINR(value)}` : "Save"}
          </Button>
        </div>
      </form>

      <aside aria-label="What will be written" className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-ink p-5 text-seashell sm:p-6 lg:sticky lg:top-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="display text-2xl font-bold">Double entry</h2>
          {lines.length > 0 && (
            <span className={cn("rounded-full px-3 py-1 text-[13px] font-semibold", debit === credit ? "bg-tea text-seashell" : "bg-red text-white")}>
              {debit === credit ? "Balanced" : "Not balanced"}
            </span>
          )}
        </div>
        {lines.length === 0 ? (
          <p className="text-[15px] opacity-75">Enter an amount to see what will be written.</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-seashell/15">
              {lines.map((l, i) => (
                <li key={i} className="flex items-start gap-3 py-3">
                  <span className="mt-0.5 inline-flex w-9 shrink-0 justify-center rounded-md bg-seashell/15 py-0.5 text-[12px] font-semibold">{l.side}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{l.account}</span>
                    <span className="block text-[13px] opacity-70">{l.note}</span>
                  </span>
                  <span className="num font-semibold">{formatINR(l.amount)}</span>
                </li>
              ))}
            </ul>
            <dl className="grid grid-cols-2 gap-2 text-[14px]">
              <div className="rounded-2xl bg-seashell/10 p-3">
                <dt className="opacity-70">Your wallets</dt>
                <dd className="num mt-1 font-semibold">{walletEffect === 0n ? "No change" : `${walletEffect > 0n ? "+" : "−"}${formatINR(walletEffect > 0n ? walletEffect : -walletEffect)}`}</dd>
              </div>
              <div className="rounded-2xl bg-seashell/10 p-3">
                <dt className="opacity-70">Profit & loss</dt>
                <dd className="num mt-1 font-semibold">{profitEffect === 0n ? "No change" : `${profitEffect > 0n ? "+" : "−"}${formatINR(profitEffect > 0n ? profitEffect : -profitEffect)}`}</dd>
              </div>
            </dl>
            <p className="num text-[13px] opacity-75">
              Debits {formatINR(debit)} = Credits {formatINR(credit)}
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
