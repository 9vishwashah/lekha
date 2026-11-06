"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { voidExpense } from "@/app/(app)/actions/records";

export function VoidExpense({ id, linked, split }: { id: string; linked: boolean; split?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button variant="ghost" className="mt-8" onClick={() => setOpen(true)}>
        Void this expense
      </Button>
    );
  return (
    <div className="mt-8 flex flex-col gap-3 rounded-[24px] bg-sunken p-5">
      <p>
        {split
          ? "Voiding keeps it in history and removes the whole split: every person's share, your own share and the cash entry."
          : `Voiding keeps the expense in history and removes it from totals${linked ? ", together with its ledger entry" : ""}.`}
      </p>
      <Field label="Reason">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={300} />}</Field>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={pending || !reason.trim()}
          onClick={() =>
            start(async () => {
              const res = await voidExpense(id, reason);
              if (!res.ok) return void toast.error(res.error);
              toast.success(res.message ?? "Voided");
              router.push("/expenses");
            })
          }
        >
          Void expense
        </Button>
      </div>
    </div>
  );
}
