"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setLedgerBooks } from "@/app/(app)/actions/ledgers";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";

const IN = [
  { value: "", label: "Ask each time" },
  { value: "direct_income", label: "Direct income (sales, billing)" },
  { value: "income", label: "Indirect income (interest, rent, other)" },
  { value: "capital", label: "Capital added" },
  { value: "transfer", label: "Transfer between wallets" },
];
const OUT = [
  { value: "", label: "Ask each time" },
  { value: "direct_expense", label: "Direct expense (labour, material)" },
  { value: "expense", label: "Indirect expense (office, rent, other)" },
  { value: "drawings", label: "Personal drawings" },
  { value: "transfer", label: "Transfer between wallets" },
];

export interface MeaningLedger {
  id: string;
  name: string;
  default_in_nature: string | null;
  default_out_nature: string | null;
}

/**
 * The accounting head a cash or bank ledger's plain money in and out usually goes under, set once.
 * An entry marked on its own keeps its own head.
 */
export function LedgerMeaningForm({ ledger, count }: { ledger: MeaningLedger; count?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [moneyIn, setIn] = useState(ledger.default_in_nature ?? "");
  const [moneyOut, setOut] = useState(ledger.default_out_nature ?? "");

  const save = () =>
    start(async () => {
      const res = await setLedgerBooks(ledger.id, { default_in_nature: moneyIn as "income", default_out_nature: moneyOut as "expense" });
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Saved");
      router.refresh();
    });

  return (
    <div className={count !== undefined ? "flex flex-col gap-3 rounded-[24px] bg-surface p-4 ring-1 ring-inset ring-line/70 sm:p-5" : "flex flex-col gap-4"}>
      {count !== undefined ? (
        <p className="text-[15px]">
          <span className="font-semibold">{ledger.name}</span>: {count} {count === 1 ? "entry has" : "entries have"} no head yet. Choose where this ledger&apos;s money in and out usually go, and every one of them follows. An entry you mark yourself keeps its own head.
        </p>
      ) : (
        <p className="text-[13px] text-ink-2">
          Where plain money in and out of this ledger usually go in the books. Payments for invoices, expenses, advances and people are already counted where they belong and are not affected.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Money in counts as">
          {(p) => (
            <Select {...p} value={moneyIn} onChange={(e) => setIn(e.target.value)}>
              {IN.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Money out counts as">
          {(p) => (
            <Select {...p} value={moneyOut} onChange={(e) => setOut(e.target.value)}>
              {OUT.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Button className="w-fit" disabled={pending} onClick={save}>
        {pending ? "Saving…" : count !== undefined ? `Apply to ${ledger.name}` : "Save"}
      </Button>
    </div>
  );
}
