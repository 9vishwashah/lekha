"use client";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addCategory, saveExpense } from "@/app/(app)/actions/records";
import { Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Button } from "@/components/ui/button";
import { PAYMENT_MODES } from "@/lib/types";
import { SplitWith } from "@/components/app/split-with";
import type { ClientOption } from "@/components/app/client-picker";
import { useWallet, WalletSelect, type WalletOption } from "@/components/app/wallet-select";

export interface ExpenseValues {
  id: string;
  category_id: string;
  expense_date: string;
  title: string;
  amount: string;
  vendor: string | null;
  payment_mode: string | null;
  reference_no: string | null;
  contractor_id: string | null;
  ledger_id: string | null;
  gst_rate: string | null;
  gst_amount: string | null;
  notes: string | null;
}

/**
 * Expense entry. Choosing "Paid from a ledger" also records one Money Out entry in that ledger,
 * saved together with the expense. Reports count the expense once and the cash once.
 *
 * "With whom" splits it: each person's share lands on their client page, your own share is the
 * expense, and the full amount leaves the ledger.
 */
export function ExpenseForm({
  categories,
  contractors,
  ledgers,
  today,
  expense,
  clients,
  withClient,
}: {
  categories: { id: string; name: string }[];
  contractors: { id: string; name: string }[];
  ledgers: WalletOption[];
  today: string;
  expense?: ExpenseValues;
  clients?: ClientOption[];
  withClient?: string;
}) {
  const router = useRouter();
  const [key] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now())));
  const [state, action, pending] = useActionState(saveExpense.bind(null, expense?.id ?? null), null);
  const [cats, setCats] = useState(categories);
  const [category, setCategory] = useState(expense?.category_id ?? categories[0]?.id ?? "");
  const [newCat, setNewCat] = useState("");
  const [adding, start] = useTransition();
  const [amount, setAmount] = useState(expense?.amount ?? "");
  const [split, setSplit] = useState({ splitting: Boolean(withClient), theyPaid: false });
  const [mode, setMode] = useState(expense?.payment_mode ?? "");
  const wallet = useWallet(ledgers, mode);
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message ?? "Saved");
      router.push(withClient ? `/contractors/${withClient}` : "/expenses");
      router.refresh();
    }
  }, [state, router, withClient]);

  return (
    <form action={action} className="flex flex-col gap-5">
      {!expense && <input type="hidden" name="idempotency_key" value={key} />}
      <Field label="Amount" error={err("amount")}>
        {(p) => <MoneyInput {...p} big name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" required autoFocus={!expense} />}
      </Field>
      <Field label="What was it for?" error={err("title")}>
        {(p) => <Input {...p} name="title" defaultValue={expense?.title} required maxLength={200} placeholder="Cement – 20 bags" />}
      </Field>
      {!expense && clients && <SplitWith clients={clients} amount={amount} initial={withClient} onChange={setSplit} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" error={err("expense_date")}>
          {(p) => <DateInput {...p} name="expense_date" defaultValue={expense?.expense_date ?? today} required />}
        </Field>
        <Field label="Category" error={err("category_id")}>
          {(p) => (
            <Select {...p} name="category_id" value={category} onChange={(e) => setCategory(e.target.value)} required>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="flex gap-2">
        <label htmlFor="new-cat" className="sr-only">
          New category
        </label>
        <Input id="new-cat" value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Add a category" maxLength={60} />
        <Button
          variant="secondary"
          disabled={adding || !newCat.trim()}
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vendor / payee" optional>
          {(p) => <Input {...p} name="vendor" defaultValue={expense?.vendor ?? ""} maxLength={160} />}
        </Field>
        <Field label="Payment mode" optional>
          {(p) => (
            <Select {...p} name="payment_mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="">Not set</option>
              {PAYMENT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Reference / bill no." optional>
          {(p) => <Input {...p} name="reference_no" defaultValue={expense?.reference_no ?? ""} maxLength={80} />}
        </Field>
        {!split.splitting && (
          <Field label="Tag a client" optional hint="Only labels this expense in reports. To put it on their balance, use With whom.">
            {(p) => (
              <Select {...p} name="contractor_id" defaultValue={expense?.contractor_id ?? ""}>
                <option value="">None</option>
                {contractors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      {expense ? (
        expense.ledger_id && (
          <p className="rounded-2xl bg-sunken p-4 text-sm text-ink-2">
            Paid from {ledgers.find((l) => l.id === expense.ledger_id)?.name ?? "a ledger"}. Changes here update that ledger entry too.
          </p>
        )
      ) : (
        !split.theyPaid && (
          <WalletSelect
            wallets={ledgers}
            value={wallet.value}
            onChange={wallet.setValue}
            name="ledger_id"
            label="Paid from"
            hint={split.splitting ? "The full amount leaves this wallet, once. Only your share counts as your expense." : "Records the money leaving this wallet, linked to this expense. Follows the payment mode until you change it."}
          />
        )
      )}
      {!split.splitting && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GST rate %" optional error={err("gst_rate")}>
            {(p) => <Input {...p} name="gst_rate" inputMode="decimal" defaultValue={expense?.gst_rate ? String(Number(expense.gst_rate)) : ""} />}
          </Field>
          <Field label="GST included" optional error={err("gst_amount")} hint="GST paid on this expense, if shown on the bill">
            {(p) => <MoneyInput {...p} name="gst_amount" defaultValue={expense?.gst_amount ?? ""} />}
          </Field>
        </div>
      )}
      <Field label="Notes" optional>
        {(p) => <Textarea {...p} name="notes" defaultValue={expense?.notes ?? ""} maxLength={2000} />}
      </Field>
      {state && !state.ok && <p className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">{state.error}</p>}
      <div className="sticky bottom-24 z-10 lg:bottom-4">
        <Button type="submit" size="lg" disabled={pending} className="w-full shadow-[0_12px_32px_rgb(29_29_27/0.22)] sm:w-auto">
          {pending ? "Saving…" : expense ? "Save changes" : "Save expense"}
        </Button>
      </div>
    </form>
  );
}
