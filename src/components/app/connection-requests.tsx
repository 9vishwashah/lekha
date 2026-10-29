"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/bits";
import { respondConnection } from "@/app/(app)/actions/connections";
import type { ConnectionRequest } from "@/lib/server/context";
import { relativeTime } from "@/lib/domain/dates";

/** Requests from people who keep you as a client or friend in their Lekha. You decide; nothing links before. */
export function ConnectionRequests({ requests }: { requests: ConnectionRequest[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = requests.filter((r) => !hidden.has(r.id));
  if (visible.length === 0) return null;
  return (
    <section aria-label="Connect requests" className="flex flex-col gap-3">
      {visible.map((r) => (
        <Request key={r.id} r={r} onDone={() => setHidden((h) => new Set(h).add(r.id))} />
      ))}
    </section>
  );
}

function Request({ r, onDone }: { r: ConnectionRequest; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const answer = (accept: boolean) =>
    start(async () => {
      const res = await respondConnection(r.id, accept);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Done");
      onDone();
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-lavender p-5 text-ink sm:flex-row sm:items-center sm:p-6">
      <Avatar name={r.from_name} tone="ink" className="size-12 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="display text-xl font-bold leading-tight sm:text-2xl">
          {r.from_name} <span className="font-semibold opacity-70">· {r.business}</span> wants to connect
        </p>
        <p className="mt-1 text-[14px] opacity-80">
          They keep you as “{r.as_name}”. Accept to see the shared accounts you’re part of. You see only those, never the rest of their
          books, and they never see yours. · {relativeTime(r.created_at)}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="light" disabled={pending} onClick={() => answer(false)}>
          Decline
        </Button>
        <Button disabled={pending} onClick={() => answer(true)}>
          {pending ? "Saving…" : "Accept"}
        </Button>
      </div>
    </div>
  );
}
