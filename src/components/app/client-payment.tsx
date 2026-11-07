"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { recordClientPayment } from "@/app/(app)/actions/records";
import { Button } from "@/components/ui/button";
import { Field, Input, MoneyInput, Select } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Segmented } from "@/components/ui/segmented";
import { PAYMENT_MODES } from "@/lib/types";
import { formatINR, tryPaise } from "@/lib/domain/money";
import { useWallet, WalletSelect, type WalletOption } from "@/components/app/wallet-select";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

type Kind = "received" | "paid" | "opening";

/**
 * Money between you and a client, without choosing a ledger. "Old balance" is for what was already
 * owed before Lekha. Cash ledgers are optional and limited to cash books: a party ledger is already
 * an account with this person.
 */
export function ClientPaymentForm({
  client,
  clients,
  cashLedgers,
  today,
  onDone,
}: {
  client?: { id: string; name: string };
  clients?: { id: string; name: string }[];
  cashLedgers: WalletOption[];
  today: string;
  onDone: (clientId: string) => void;
}) {
  const router = useRouter();
  const [clientId, setClientId] = useState(client?.id ?? clients?.[0]?.id ?? "");
  const [kind, setKind] = useState<Kind>("received");
  const [theyOwe, setTheyOwe] = useState("yes");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [mode, setMode] = useState("");
  const wallet = useWallet(cashLedgers, mode);
  const ledger = wallet.value;
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [key, setKey] = useState(newKey);

  const name = (client?.name ?? clients?.find((c) => c.id === clientId)?.name ?? "them").split(" ")[0];
  const value = tryPaise(amount);
  const label =
    kind === "received" ? `Record ${value ? formatINR(value) : ""} received` : kind === "paid" ? `Record ${value ? formatINR(value) : ""} paid` : "Add old balance";

  const submit = () =>
    start(async () => {
      setError(null);
      const res = await recordClientPayment({
        contractor_id: clientId,
        kind,
        they_owe: theyOwe === "yes",
        amount,
        txn_date: date,
        payment_mode: mode as "cash",
        reference_no: reference,
        ledger_id: ledger,
        idempotency_key: key,
      });
      if (!res.ok) return setError(res.error);
      toast.success(res.message ?? "Saved");
      setKey(newKey());
      router.refresh();
      onDone(clientId);
    });

  return (
    <div className="flex flex-col gap-5">
      {clients && (
        <Field label="Client">
          {(p) => (
            <Select {...p} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Segmented
        label="What happened"
        value={kind}
        onChange={setKind}
        options={[
          { value: "received", label: "You received", tone: "in" },
          { value: "paid", label: "You paid", tone: "out" },
          { value: "opening", label: "Old balance" },
        ]}
      />
      {kind === "opening" && (
        <Segmented
          label="Who owes"
          value={theyOwe}
          onChange={setTheyOwe}
          options={[
            { value: "yes", label: `${name} owes you` },
            { value: "no", label: `You owe ${name}` },
          ]}
        />
      )}
      <Field label="Amount">{(p) => <MoneyInput {...p} big value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date">{(p) => <DateInput {...p} value={date} onChange={setDate} />}</Field>
        {kind !== "opening" && (
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
        )}
      </div>
      {kind !== "opening" && (
        <WalletSelect
          wallets={cashLedgers}
          value={ledger}
          onChange={wallet.setValue}
          label={kind === "received" ? "Into which wallet" : "From which wallet"}
          hint="The cash is recorded there, once. Follows the mode until you change it."
        />
      )}
      {kind !== "opening" && (
        <Field label="Reference" optional>
          {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />}
        </Field>
      )}
      {kind !== "opening" && <p className="text-[13px] text-ink-3">Paying a bill or invoice? Record it on that invoice or ledger so it shows as paid there.</p>}
      {error && <p className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">{error}</p>}
      <Button size="lg" className="w-full" disabled={pending || !value || !clientId} onClick={submit}>
        {pending ? "Saving…" : label}
      </Button>
    </div>
  );
}
