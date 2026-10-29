"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Link2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { cancelConnection, disconnectClient, requestConnection } from "@/app/(app)/actions/connections";
import { whatsappUrl } from "@/components/app/share-sheet";
import { relativeTime } from "@/lib/domain/dates";

/**
 * Links this client record to the person's own Lekha account, with their consent. Three states:
 * not connected, request sent (waiting for them), connected. The sender is never told whether the
 * email belongs to an existing account; the request simply waits until that person signs in.
 */
export function ConnectCard({
  contractor,
  pending,
  canWrite,
  whatsappTo,
}: {
  contractor: { id: string; name: string; email: string | null; linked_user_id: string | null };
  pending: { email: string; created_at: string } | null;
  canWrite: boolean;
  whatsappTo: string | null;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(contractor.email ?? "");
  const [error, setError] = useState<string | null>(null);
  const first = contractor.name.split(/\s+/)[0];

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "Something went wrong");
        toast.error(res.error ?? "Something went wrong");
        return;
      }
      toast.success(res.message ?? "Saved");
      after?.();
      router.refresh();
    });

  const nudge = (to: string) =>
    whatsappUrl(
      `Hi ${first}, I’ve added you on Lekha so our shared accounts stay in sync on both sides. Sign in at ${window.location.origin} with ${to} and accept my request.`,
      whatsappTo,
    );

  if (contractor.linked_user_id) {
    return (
      <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-tea p-5 text-seashell sm:flex-row sm:items-center sm:p-6">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-white/12">
          <Link2 className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="display text-xl font-bold">Connected on Lekha</p>
          <p className="mt-1 text-[14px] opacity-80">
            Shared accounts with {first} show up in their Lekha automatically, as {first}. They never see the rest of your books.
          </p>
        </div>
        {canWrite && (
          <Button
            variant="light"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Disconnect ${contractor.name}? They lose access to your shared accounts. Every entry stays.`)) run(() => disconnectClient(contractor.id));
            }}
          >
            Disconnect
          </Button>
        )}
      </section>
    );
  }

  if (!canWrite) return null;

  return (
    <>
      {pending ? (
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-mustard p-5 text-ink sm:flex-row sm:items-center sm:p-6">
          <div className="min-w-0 flex-1">
            <p className="display text-xl font-bold">Request sent</p>
            <p className="mt-1 break-words text-[14px] opacity-80">
              Waiting for {first} to accept. It went to {pending.email} {relativeTime(pending.created_at)}, and waits there until they sign in to
              Lekha with that email.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <a
              href={nudge(pending.email)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-5 font-medium text-surface"
            >
              <MessageCircle className="size-4" /> Tell {first}
            </a>
            <Button variant="light" disabled={busy} onClick={() => setOpen(true)}>
              Change email
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => run(() => cancelConnection(contractor.id))}>
              Withdraw
            </Button>
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 sm:flex-row sm:items-center sm:p-6">
          <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-sunken">
            <Link2 className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="display text-xl font-bold">Connect with {first} on Lekha</p>
            <p className="mt-1 text-[14px] text-ink-2">
              Once {first} accepts, your shared accounts appear in their Lekha too, with no links to send. Nothing connects until they say yes.
            </p>
          </div>
          <Button disabled={busy} onClick={() => setOpen(true)}>
            Connect
          </Button>
        </section>
      )}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={`Connect with ${first}`}
        description="The request goes to their Lekha. They need to sign in with this email to see it."
        footer={
          <Button
            size="lg"
            className="w-full"
            disabled={busy || !email.trim()}
            onClick={() => {
              setError(null);
              run(() => requestConnection(contractor.id, email), () => setOpen(false));
            }}
          >
            {busy ? "Sending…" : "Send request"}
          </Button>
        }
      >
        <form
          className="flex flex-col gap-4 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => requestConnection(contractor.id, email), () => setOpen(false));
          }}
        >
          <Field label={`${first}’s email`} hint="The one they use (or will use) to sign in to Lekha. Saved on this client." error={error ?? undefined}>
            {(p) => <Input {...p} type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoFocus />}
          </Field>
        </form>
      </Sheet>
    </>
  );
}
