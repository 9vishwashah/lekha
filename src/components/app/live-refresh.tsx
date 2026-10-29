"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@clerk/nextjs";
import { browserDb } from "@/lib/supabase/browser";
import { cn } from "@/lib/cn";

type LiveState = "connecting" | "live" | "offline";

/**
 * Subscribes to changes on one ledger through Supabase Realtime (RLS applies: only rows this user
 * can read are delivered) and re-renders the page from the server when something changes.
 * Falls back to a slow refresh if the socket is down. Cleans up on unmount.
 */
export function LiveRefresh({ ledgerId, tables }: { ledgerId: string; tables: string[] }) {
  const router = useRouter();
  const { session } = useSession();
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  const [state, setState] = useState<LiveState>(configured ? "connecting" : "offline");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!session) return;
    const db = browserDb(() => session.getToken());
    if (!db) return;
    const refresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 400);
    };
    let channel = db.channel(`ledger:${ledgerId}`);
    for (const table of tables) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: table === "ledgers" ? `id=eq.${ledgerId}` : `ledger_id=eq.${ledgerId}` },
        refresh,
      );
    }
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setState("live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setState("offline");
    });
    // Safety net when the socket is unavailable: refresh while the tab is visible.
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && channel.state !== "joined") router.refresh();
    }, 60_000);
    return () => {
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
      db.removeChannel(channel);
    };
  }, [session, ledgerId, tables, router]);

  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-3" role="status">
      <span
        className={cn(
          "size-2 rounded-full",
          state === "live" ? "bg-in" : state === "connecting" ? "animate-pulse bg-mustard" : "bg-ink-3",
        )}
        aria-hidden
      />
      {state === "live" ? "Live" : state === "connecting" ? "Connecting" : "Updates every minute"}
    </span>
  );
}
