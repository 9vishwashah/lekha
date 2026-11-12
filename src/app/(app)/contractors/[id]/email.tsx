"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellRing, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Money } from "@/components/ui/amount";
import { sendClientReminder, setClientMonthlyStatement } from "@/app/(app)/actions/email";
import { relativeTime } from "@/lib/domain/dates";

/**
 * "Send reminder" and the monthly statement switch, on a client's page. The reminder emails what
 * they owe with their statement link; at most one every 12 hours.
 */
export function ClientEmail({
  client,
  owes,
  monthlyOn,
  lastReminded,
  ready,
}: {
  client: { id: string; name: string; email: string | null };
  /** What they owe you right now (paise, as text), or "0". */
  owes: string;
  monthlyOn: boolean;
  lastReminded: string | null;
  /** The server has email set up. */
  ready: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const first = client.name.split(/\s+/)[0];
  const due = BigInt(owes);

  const remind = () =>
    start(async () => {
      const res = await sendClientReminder(client.id, note);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Reminder sent");
      setOpen(false);
      setNote("");
      router.refresh();
    });

  const toggleMonthly = () =>
    start(async () => {
      const res = await setClientMonthlyStatement(client.id, !monthlyOn);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Saved");
      router.refresh();
    });

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <BellRing className="size-4" /> Send reminder
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Remind ${first}`} description={client.email ? `By email to ${client.email}` : undefined}>
        <div className="flex flex-col gap-4 pb-2">
          {!ready ? (
            <p className="rounded-2xl bg-sunken p-3 text-[14px] text-ink-2">Email is not set up on the server yet (Resend API key and sender address).</p>
          ) : !client.email ? (
            <p className="rounded-2xl bg-sunken p-3 text-[14px] text-ink-2">Add {first}’s email address first: use Edit on this page.</p>
          ) : due <= 0n ? (
            <p className="rounded-2xl bg-sunken p-3 text-[14px] text-ink-2">Nothing is pending from {first} right now.</p>
          ) : (
            <>
              <div className="rounded-[24px] bg-mustard p-5">
                <div className="text-sm font-semibold">Payment reminder</div>
                <Money value={due} className="display mt-1 block text-4xl font-extrabold" />
                <div className="text-sm font-medium">pending from {first}, with a link to their statement</div>
              </div>
              <label className="flex flex-col gap-1.5 text-[15px]">
                <span className="font-medium text-ink-2">Add a message (optional)</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="e.g. Please clear this by Friday. Thank you!"
                  className="rounded-[var(--radius-field)] bg-white p-3 text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink"
                />
              </label>
              {lastReminded && <p className="text-[13px] text-ink-3">Last reminder sent {relativeTime(lastReminded)}.</p>}
              <Button size="lg" disabled={pending} onClick={remind}>
                <BellRing className="size-4" /> {pending ? "Sending…" : "Send reminder email"}
              </Button>
              <p className="text-[13px] text-ink-3">Replies come straight to your email. One reminder per client every 12 hours.</p>
            </>
          )}
          <div className="mt-2 flex items-start gap-3 rounded-2xl bg-surface p-4 ring-1 ring-inset ring-line">
            <CalendarClock className="mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">Monthly statement</div>
              <div className="text-[14px] text-ink-2">On the 1st of every month, {first} gets their balance and statement link by email.</div>
            </div>
            <Button size="sm" variant={monthlyOn ? "primary" : "secondary"} disabled={pending || (!client.email && !monthlyOn)} onClick={toggleMonthly}>
              {monthlyOn ? "On" : "Off"}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
