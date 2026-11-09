"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { deleteExpense } from "@/app/(app)/actions/records";

export function DeleteExpense({ id, linked, split }: { id: string; linked: boolean; split?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button variant="ghost" className="mt-8" onClick={() => setOpen(true)}>
        Delete this expense
      </Button>
    );
  return (
    <div className="mt-8 flex flex-col gap-3 rounded-[24px] bg-sunken p-5">
      <p>
        {split
          ? "Deletes the whole split for good: every person's share, your own share and the cash entry."
          : `Deletes this expense for good${linked ? ", together with its ledger entry" : ""}. It cannot be undone.`}
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await deleteExpense(id);
              if (!res.ok) return void toast.error(res.error);
              toast.success(res.message ?? "Deleted");
              router.push("/expenses");
            })
          }
        >
          Delete for good
        </Button>
      </div>
    </div>
  );
}
