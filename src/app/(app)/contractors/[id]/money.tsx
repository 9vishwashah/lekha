"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { adoptDirectLedger } from "@/app/(app)/actions/records";
import { Button, LinkButton } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ClientPaymentForm } from "@/components/app/client-payment";

/** The two things you most often do on someone's page, with no ledger to pick first. */
export function ClientMoneyButtons({
  client,
  cashLedgers,
  today,
}: {
  client: { id: string; name: string };
  cashLedgers: { id: string; name: string }[];
  today: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <LinkButton href={`/expenses/new?with=${client.id}`}>
        <Plus className="size-4" /> Add expense
      </LinkButton>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Record payment
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Record payment" description={client.name}>
        {open && <ClientPaymentForm client={client} cashLedgers={cashLedgers} today={today} onDone={() => setOpen(false)} />}
      </Sheet>
    </>
  );
}

/** Asked for, never automatic: a two-person account may have a name and purpose of its own. */
export function AdoptAccount({ ledgerId, ledgerName, clientName }: { ledgerId: string; ledgerName: string; clientName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className="mt-2 min-h-11 text-sm font-medium text-ink-2 underline underline-offset-4 hover:text-ink disabled:opacity-50"
      onClick={() =>
        start(async () => {
          if (!confirm(`Make “${ledgerName}” the main account with ${clientName}? New expenses and payments on this page will go here. Nothing already in it changes.`)) return;
          const res = await adoptDirectLedger(ledgerId);
          if (!res.ok) return void toast.error(res.error);
          toast.success(res.message ?? "Done");
          router.refresh();
        })
      }
    >
      Use as main account
    </button>
  );
}
