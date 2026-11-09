"use client";
import { ActionForm } from "@/components/ui/action-form";
import { useActionState, useState } from "react";
import { Check } from "lucide-react";
import { ClientPicker, type ClientOption } from "./client-picker";
import { createLedger } from "@/app/(app)/actions/ledgers";
import { Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { WALLET, WALLET_COLORS } from "@/components/ui/bits";
import { cn } from "@/lib/cn";

type LedgerType = "wallet" | "basic" | "taxation" | "personal";

const TYPES: { value: LedgerType; title: string; body: string; color: string }[] = [
  { value: "wallet", title: "Cash or bank", body: "Where your own money sits: cash in hand, a bank account, UPI.", color: "bg-tea text-seashell" },
  { value: "basic", title: "Client ledger", body: "A running account with one person or business: what they owe you, what you owe them.", color: "bg-mustard" },
  { value: "taxation", title: "Taxation", body: "An account with bills, GST and TDS, amounts after TDS, and tax payments to Government.", color: "bg-lavender" },
  { value: "personal", title: "Shared account", body: "For friends, family, trips and flatmates. Split costs and settle up.", color: "bg-pink" },
];

export function LedgerForm({
  contractors,
  initialType,
  defaultContractor,
  defaultPeople = [],
  defaultGstMode,
  today,
}: {
  contractors: ClientOption[];
  initialType: LedgerType;
  defaultContractor?: string;
  defaultPeople?: string[];
  defaultGstMode: "intra" | "inter";
  today: string;
}) {
  const [state, action, pending] = useActionState(createLedger, null);
  const [type, setType] = useState<LedgerType>(initialType);
  const [walletKind, setWalletKind] = useState<"cash" | "bank">("bank");
  const [color, setColor] = useState<string>(initialType === "taxation" ? "lavender" : initialType === "personal" ? "pink" : initialType === "wallet" ? "sky" : "mustard");
  const [people, setPeople] = useState<string[]>(defaultPeople);
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  const chooseType = (t: LedgerType) => {
    setType(t);
    setColor(t === "taxation" ? "lavender" : t === "personal" ? "pink" : t === "wallet" ? "sky" : "mustard");
  };

  return (
    <ActionForm action={action} className="flex flex-col gap-8">
      <input type="hidden" name="ledger_type" value={type === "wallet" ? "basic" : type} />
      <input type="hidden" name="color" value={color} />
      {type !== "personal" && <input type="hidden" name="perspective" value={type === "wallet" ? "cashbook" : "party"} />}
      {type === "wallet" && <input type="hidden" name="wallet_kind" value={walletKind} />}

      <fieldset>
        <legend className="mb-3 text-sm font-medium text-ink-2">Ledger type</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={type === t.value}
              onClick={() => chooseType(t.value)}
              className={cn(
                "relative flex min-h-40 flex-col justify-between rounded-[26px] p-5 text-left transition-transform active:scale-[0.99]",
                t.color,
                type === t.value ? "ring-4 ring-ink ring-offset-2 ring-offset-canvas" : "opacity-80 hover:opacity-100",
              )}
            >
              <span className="display text-2xl font-bold">{t.title}</span>
              <span className="text-sm text-ink/75">{t.body}</span>
              {type === t.value && (
                <span className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-full bg-ink text-surface">
                  <Check className="size-4" />
                </span>
              )}
            </button>
          ))}
        </div>
      </fieldset>

      <Field label="Ledger name" error={err("name")} hint={type === "personal" ? "For example: Goa Trip 2026, Flatmate expenses, Vishwa × Suraj" : type === "wallet" ? "For example: HDFC Current, Petty cash" : "For example: Ramesh Saini – site work"}>
        {(p) => <Input {...p} name="name" required maxLength={120} autoComplete="off" />}
      </Field>

      {type === "personal" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-ink-2">Who else is in this account?</legend>
          <p className="-mt-1 text-[13px] text-ink-3">
            You are added automatically. Pick people from your client accounts, or add someone new. Their balance then shows on your home screen
            and on their client page, and you can invite them to see their own side.
          </p>
          {people.length === 1 && (
            <p className="rounded-2xl bg-sunken p-3 text-[13px] text-ink-2">
              Just one person? You don&apos;t need an account for this. Add the expense on their client page or from New expense.
            </p>
          )}
          <ClientPicker clients={contractors} selected={people} onChange={(ids) => setPeople(ids)} name="participant_client_ids" />
          {err("participant_client_ids") && <p className="text-[13px] font-medium text-out">{err("participant_client_ids")}</p>}
        </fieldset>
      ) : (
        <>
          {type === "wallet" ? (
            <Segmented
              label="Kind of wallet"
              value={walletKind}
              onChange={setWalletKind}
              options={[
                { value: "bank", label: "Bank or UPI" },
                { value: "cash", label: "Cash" },
              ]}
            />
          ) : (
            <Field label="Client" optional hint="Who this ledger is with. Add new people from Client Accounts.">
              {(p) => (
                <Select {...p} name="contractor_id" defaultValue={defaultContractor ?? ""}>
                  <option value="">No client</option>
                  {contractors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Opening balance" optional error={err("opening_balance")} hint={type === "wallet" ? "What is in it today" : "What they owe you today. Use a minus sign if you owe them."}>
              {(p) => <MoneyInput {...p} name="opening_balance" placeholder="0" />}
            </Field>
            <Field label="Opening balance date" optional error={err("opening_balance_date")}>
              {(p) => <DateInput {...p} name="opening_balance_date" defaultValue={today} />}
            </Field>
          </div>

          {type === "taxation" && (
            <Field label="Usual GST type" hint="Pre-fills each bill. You can change it per bill.">
              {(p) => (
                <Select {...p} name="gst_mode" defaultValue={defaultGstMode}>
                  <option value="intra">Intra-state (CGST + SGST)</option>
                  <option value="inter">Inter-state (IGST)</option>
                </Select>
              )}
            </Field>
          )}

          <Field label="Reference number" optional>
            {(p) => <Input {...p} name="reference_no" maxLength={60} />}
          </Field>
        </>
      )}

      <Field label="Description" optional>
        {(p) => <Textarea {...p} name="description" maxLength={500} />}
      </Field>

      <fieldset>
        <legend className="mb-3 text-sm font-medium text-ink-2">Card colour</legend>
        <div className="flex flex-wrap gap-2">
          {WALLET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
              className={cn("size-11 rounded-full", WALLET[c].bg, color === c && "ring-4 ring-ink ring-offset-2 ring-offset-canvas")}
            />
          ))}
        </div>
      </fieldset>

      {state && !state.ok && !state.fieldErrors && (
        <p role="alert" className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">
          {state.error}
        </p>
      )}

      <div className="sticky bottom-24 z-10 lg:bottom-4">
        <Button type="submit" size="lg" className="w-full shadow-[0_12px_32px_rgb(29_29_27/0.22)] sm:w-auto" disabled={pending}>
          {pending ? "Creating…" : "Create ledger"}
        </Button>
      </div>
    </ActionForm>
  );
}
