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
  /** linked: they are on Lekha, so their sign-up email can be used (it is never shown here). */
  client: { id: string; name: string; email: string | null; linked: boolean };
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
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [pending, start] = useTransition();
  const first = client.name.split(/\s+/)[0];
  const due = BigInt(owes);
  // Where it goes unless a new address is typed: their card's email, else their Lekha email.
  const hasDefault = Boolean(client.email) || client.linked;
  const typing = changing || !hasDefault;
  const destination = typing ? null : client.email ? client.email : `${first}’s Lekha email`;

  const remind = () =>
    start(async () => {
      const res = await sendClientReminder(client.id, note, typing ? newEmail : undefined);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Reminder sent");
      setOpen(false);
      setNote("");
      setChanging(false);
      setNewEmail("");
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
      <Sheet open={open} onClose={() => setOpen(false)} title={`Remind ${first}`} description="By email, with their statement link">
        <div className="flex flex-col gap-4 pb-2">
          {!ready ? (
            <p className="rounded-2xl bg-sunken p-3 text-[14px] text-ink-2">Email is not set up on the server yet (Resend API key and sender address).</p>
          ) : due <= 0n ? (
            <p className="rounded-2xl bg-sunken p-3 text-[14px] text-ink-2">Nothing is pending from {first} right now.</p>
          ) : (
            <>
              <div className="rounded-[24px] bg-mustard p-5">
                <div className="text-sm font-semibold">Payment reminder</div>
                <Money value={due} className="display mt-1 block text-4xl font-extrabold" />
                <div className="text-sm font-medium">pending from {first}, with a link to their statement</div>
              </div>
              {typing ? (
                <label className="flex flex-col gap-1.5 text-[15px]">
                  <span className="font-medium text-ink-2">{hasDefault ? "Send to a different email" : `${first}’s email`}</span>
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    maxLength={200}
                    placeholder="name@example.com"
                    className="h-12 rounded-[var(--radius-field)] bg-white px-4 text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink"
                  />
                  <span className="text-[13px] text-ink-3">
                    Saved on {first}’s profile for next time.
                    {hasDefault && (
                      <button type="button" className="ml-1 font-semibold underline underline-offset-2" onClick={() => setChanging(false)}>
                        Use {client.email ? client.email : "their Lekha email"} instead
                      </button>
                    )}
                  </span>
                </label>
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3 ring-1 ring-inset ring-line">
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink-3">Sending to</div>
                    <div className="truncate font-medium">{destination}</div>
                  </div>
                  <button type="button" className="shrink-0 text-[14px] font-semibold underline underline-offset-2" onClick={() => setChanging(true)}>
                    Change
                  </button>
                </div>
              )}
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
              <Button size="lg" disabled={pending || (typing && !newEmail.trim())} onClick={remind}>
                <BellRing className="size-4" /> {pending ? "Sending…" : "Send reminder email"}
              </Button>
              <p className="text-[13px] text-ink-3">Replies come straight to your email. One reminder per client every 12 hours.</p>
            </>
          )}
          <div className="mt-2 flex items-start gap-3 rounded-2xl bg-surface p-4 ring-1 ring-inset ring-line">
            <CalendarClock className="mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">Monthly statement</div>
              <div className="text-[14px] text-ink-2">
                On the 1st of every month, {first} gets their balance and statement link by email{client.linked && !client.email ? " (to their Lekha email)" : ""}.
                {!hasDefault && " Send a reminder with their email first, or link them to their Lekha account."}
              </div>
            </div>
            <Button size="sm" variant={monthlyOn ? "primary" : "secondary"} disabled={pending || (!hasDefault && !monthlyOn)} onClick={toggleMonthly}>
              {monthlyOn ? "On" : "Off"}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
