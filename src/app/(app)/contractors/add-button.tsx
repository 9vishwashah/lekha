"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ContractorForm } from "@/components/app/contractor-form";

export function AddContractorButton({ existing }: { existing: { id: string; name: string; phone: string | null }[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-5" /> Add client
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="New client account">
        <ContractorForm
          existing={existing}
          onDone={(id) => {
            setOpen(false);
            router.push(`/contractors/${id}`);
          }}
        />
      </Sheet>
    </>
  );
}
