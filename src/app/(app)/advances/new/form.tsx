"use client";
import { walletForMode } from "@/lib/domain/books";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAdvance } from "@/app/(app)/actions/records";
import { Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Button } from "@/components/ui/button";
import { PAYMENT_MODES } from "@/lib/types";

export function AdvanceForm({
  contractors,
  ledgers,
  defaultContractor,
  today,
}: {
  contractors: { id: string; name: string }[];
  ledgers: { id: string; name: string; contractor_id: string | null; kind: "cash" | "bank" | null }[];
  defaultContractor?: string;
  today: string;
}) {
  const router = useRouter();
  const [key] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now())));
  const [state, action, pending] = useActionState(createAdvance, null);
  const [contractor, setContractor] = useState(defaultContractor ?? contractors[0]?.id ?? "");
  const suggested = ledgers.filter((l) => l.contractor_id === contractor);
  const [mode, setMode] = useState("");
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message ?? "Advance recorded");
      router.push(`/advances/${state.data!.id}`);
    }
  }, [state, router]);

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="idempotency_key" value={key} />
      <Field label="Given to" error={err("contractor_id")}>
        {(p) => (
          <Select {...p} name="contractor_id" value={contractor} onChange={(e) => setContractor(e.target.value)}>
            {contractors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Amount" error={err("amount")}>
        {(p) => <MoneyInput {...p} big name="amount" placeholder="0" required />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date given" error={err("given_date")}>
          {(p) => <DateInput {...p} name="given_date" defaultValue={today} required />}
        </Field>
        <Field label="Expected back by" optional error={err("expected_recovery_date")}>
          {(p) => <DateInput {...p} name="expected_recovery_date" />}
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
        <Field label="Reference" optional>
          {(p) => <Input {...p} name="reference_no" maxLength={80} />}
        </Field>
      </div>
      <Field label="Purpose" optional>
        {(p) => <Input {...p} name="purpose" maxLength={200} placeholder="Material purchase for site 2" />}
      </Field>
      <Field
        label="Paid from a ledger"
        optional
        hint="Also records the cash leaving that ledger. Recoveries in cash will be recorded there too. Leave empty to track the advance on its own."
      >
        {(p) => (
          <Select {...p} name="ledger_id" defaultValue={suggested[0]?.id ?? walletForMode(ledgers, mode)} key={`${contractor}${mode}`}>
            <option value="">Not paid from a ledger</option>
            {ledgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Notes" optional>
        {(p) => <Textarea {...p} name="notes" maxLength={2000} />}
      </Field>
      {state && !state.ok && <p className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">{state.error}</p>}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Saving…" : "Record advance"}
      </Button>
    </form>
  );
}
