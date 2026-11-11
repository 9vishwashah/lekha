"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { relativeTime } from "@/lib/domain/dates";
import { cn } from "@/lib/cn";

export type ShareAck = { at: string; name: string | null; current: boolean } | null;

/**
 * "Confirm statement" on a shared ledger. The person it was shared with says the entries are
 * right; the owner sees that. The confirmation is for the statement exactly as shown: when the
 * owner adds, changes or deletes an entry, the button comes back and asks again.
 */
export function AcknowledgeButton({ token, version, ack, suggestedName }: { token: string; version: string; ack: ShareAck; suggestedName: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(ack?.name ?? suggestedName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (ack?.current) {
    return (
      <span
        role="status"
        className="inline-flex h-12 shrink-0 items-center gap-2 rounded-full bg-in-soft px-4 text-[14px] font-semibold text-in ring-1 ring-inset ring-in/20"
        title={`Confirmed ${relativeTime(ack.at)}`}
      >
        <CheckCircle2 className="size-4" /> Confirmed
      </span>
    );
  }

  const confirm = () =>
    start(async () => {
      setError(null);
      const res = await fetch(`/api/share/${token}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, name: name.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; changed?: boolean };
      if (!res.ok) {
        setError(body.error ?? "That could not be saved. Try again.");
        if (body.changed) {
          setOpen(false);
          toast.message(body.error!);
          router.refresh();
        }
        return;
      }
      setOpen(false);
      toast.success("Thanks. The sender can see you confirmed this statement.");
      router.refresh();
    });

  return (
    <>
      <Button className={cn("h-12 shrink-0 gap-2", ack && "bg-mustard text-ink hover:bg-mustard/90")} onClick={() => setOpen(true)}>
        <ShieldCheck className="size-4" />
        {ack ? "Confirm again" : "Confirm statement"}
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Is this statement right?"
        description={
          ack
            ? `Entries changed since you confirmed ${relativeTime(ack.at)}. Check the latest ones, then confirm again.`
            : "Confirm that the entries and balance shown here match your records. The sender will see it."
        }
      >
        <div className="flex flex-col gap-4 pb-2">
          <label className="flex flex-col gap-1.5 text-[15px]">
            <span className="font-medium text-ink-2">Your name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoComplete="name"
              className="h-12 rounded-[var(--radius-field)] bg-white px-4 text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
          {error && (
            <p role="alert" className="rounded-2xl bg-[#f6dcda] p-3 font-medium text-out">
              {error}
            </p>
          )}
          <Button size="lg" onClick={confirm} disabled={pending}>
            <CheckCircle2 className="size-5" /> {pending ? "Saving…" : "Yes, this is right"}
          </Button>
          <p className="text-[13px] text-ink-3">If something is wrong, tell the sender instead. Confirming changes nothing in the statement.</p>
        </div>
      </Sheet>
    </>
  );
}
