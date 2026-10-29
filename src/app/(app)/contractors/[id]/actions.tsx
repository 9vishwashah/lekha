"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Field, Select } from "@/components/ui/field";
import { ContractorForm } from "@/components/app/contractor-form";
import { mergeContractors, setContractorActive } from "@/app/(app)/actions/records";
import type { Contractor } from "@/lib/types";

export function ContractorActions({
  contractor,
  taxIds,
  others,
  canMerge,
}: {
  contractor: Contractor;
  taxIds: { gstin: string | null; pan: string | null } | null;
  others: { id: string; name: string; phone: string | null }[];
  canMerge: boolean;
}) {
  const router = useRouter();
  const [edit, setEdit] = useState(false);
  const [merge, setMerge] = useState(false);
  const [into, setInto] = useState(others[0]?.id ?? "");
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => setEdit(true)}>
        Edit
      </Button>
      <Button
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await setContractorActive(contractor.id, !contractor.is_active);
            if (res.ok) toast.success(res.message ?? "Saved");
            else toast.error(res.error);
            router.refresh();
          })
        }
      >
        {contractor.is_active ? "Mark inactive" : "Reactivate"}
      </Button>
      {canMerge && others.length > 0 && (
        <Button variant="ghost" onClick={() => setMerge(true)}>
          Merge…
        </Button>
      )}
      <Sheet open={edit} onClose={() => setEdit(false)} title="Edit client account">
        {taxIds === null && contractor.kind === "business" && <p className="mb-3 text-sm text-ink-3">GSTIN and PAN are hidden for your role.</p>}
        <ContractorForm contractor={contractor} existing={others} taxIds={taxIds} onDone={() => setEdit(false)} />
      </Sheet>
      <Sheet open={merge} onClose={() => setMerge(false)} title="Merge client accounts" description="Use this when the same person was added twice.">
        <div className="flex flex-col gap-4">
          <p className="text-[15px] text-ink-2">
            Every ledger, advance and expense linked to <strong>{contractor.name}</strong> moves to the account you choose. {contractor.name} is then
            marked inactive. Entries and their history are not changed.
          </p>
          <Field label="Merge into">
            {(p) => (
              <Select {...p} value={into} onChange={(e) => setInto(e.target.value)}>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.phone ? ` · ${o.phone}` : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button
            variant="danger"
            size="lg"
            disabled={pending || !into}
            onClick={() =>
              start(async () => {
                const target = others.find((o) => o.id === into)?.name;
                if (!confirm(`Move everything from ${contractor.name} to ${target}? This cannot be undone automatically.`)) return;
                const res = await mergeContractors(contractor.id, into);
                if (!res.ok) return void toast.error(res.error);
                toast.success(res.message ?? "Merged");
                router.push(`/contractors/${into}`);
              })
            }
          >
            Merge contractors
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
