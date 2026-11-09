"use client";
import { ActionForm } from "@/components/ui/action-form";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { recordAllocation, deleteAdvance, deleteAllocation } from "@/app/(app)/actions/records";
import { Card } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Field, Input, MoneyInput, Select } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Segmented } from "@/components/ui/segmented";
import { formatINR, tryPaise } from "@/lib/domain/money";
import { PAYMENT_MODES } from "@/lib/types";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()));

export function AllocationForm({
  advanceId,
  outstanding,
  today,
  hasLedger,
  bills,
}: {
  advanceId: string;
  outstanding: string;
  today: string;
  hasLedger: boolean;
  bills: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<"recovery" | "adjustment">("recovery");
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState(newKey);
  const [state, action, pending] = useActionState(async (prev: Awaited<ReturnType<typeof recordAllocation>> | null, form: FormData) => {
    const res = await recordAllocation(prev, form);
    if (res.ok) {
      toast.success(res.message ?? "Saved");
      setAmount("");
      setKey(newKey());
      router.refresh();
    }
    return res;
  }, null);
  const max = BigInt(outstanding);
  const value = tryPaise(amount);
  const over = value !== null && value > max;

  return (
    <Card>
      <ActionForm action={action} className="flex flex-col gap-5">
        <input type="hidden" name="advance_id" value={advanceId} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="idempotency_key" value={key} />
        <Segmented
          label="How it came back"
          value={kind}
          onChange={setKind}
          options={[
            { value: "recovery", label: "Cash back" },
            { value: "adjustment", label: "Adjusted in a bill" },
          ]}
        />
        <p className="-mt-2 text-[13px] text-ink-3">
          {kind === "recovery"
            ? hasLedger
              ? "Records Money In in the linked ledger."
              : "Recorded against the advance only; no ledger is linked."
            : "Reduces the advance against the contractor’s bill. No cash is recorded, because none moved."}
        </p>
        <Field label="Amount" hint={`Up to ${formatINR(max)} is outstanding`} error={over ? "That is more than what is outstanding" : state && !state.ok ? state.fieldErrors?.amount : undefined}>
          {(p) => <MoneyInput {...p} big name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <button type="button" className="-mt-3 self-start text-sm font-medium underline" onClick={() => setAmount((Number(max) / 100).toFixed(2))}>
          Use full outstanding amount
        </button>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">{(p) => <DateInput {...p} name="alloc_date" defaultValue={today} required />}</Field>
          {kind === "recovery" ? (
            <Field label="Payment mode" optional>
              {(p) => (
                <Select {...p} name="payment_mode" defaultValue="">
                  <option value="">Not set</option>
                  {PAYMENT_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Field label="Bill reference" optional>
              {(p) => <Input {...p} name="bill_reference" maxLength={80} placeholder="Bill no. 42" />}
            </Field>
          )}
        </div>
        {kind === "adjustment" && bills.length > 0 && (
          <Field label="Bill in the ledger" optional>
            {(p) => (
              <Select {...p} name="bill_transaction_id" defaultValue="">
                <option value="">Not linked</option>
                {bills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {state && !state.ok && <p className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">{state.error}</p>}
        <Button type="submit" size="lg" disabled={pending || !value || over}>
          {pending ? "Saving…" : kind === "recovery" ? "Record cash back" : "Record adjustment"}
        </Button>
      </ActionForm>
    </Card>
  );
}

export function DeleteAllocation({ id, advanceId }: { id: string; advanceId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (!confirm("Delete this for good? Its ledger entry goes with it.")) return;
        start(async () => {
          const res = await deleteAllocation(id, advanceId);
          if (!res.ok) toast.error(res.error);
          else toast.success(res.message ?? "Deleted");
          router.refresh();
        });
      }}
    >
      Delete
    </Button>
  );
}

export function DeleteAdvance({ id, hasActiveAllocations }: { id: string; hasActiveAllocations: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      className="self-start"
      disabled={pending}
      onClick={() => {
        const also = hasActiveAllocations ? " Its recoveries and adjustments are deleted with it." : "";
        if (!confirm(`Delete this advance for good?${also} Its ledger entries go with it.`)) return;
        start(async () => {
          const res = await deleteAdvance(id);
          if (!res.ok) return void toast.error(res.error);
          toast.success(res.message ?? "Deleted");
          router.push("/advances");
        });
      }}
    >
      Delete this advance
    </Button>
  );
}
