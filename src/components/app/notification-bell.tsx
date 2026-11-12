"use client";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@clerk/nextjs";
import { Bell } from "lucide-react";
import { IntentLink } from "./intent-link";
import { browserDb } from "@/lib/supabase/browser";
import { unreadNotifications } from "@/app/(app)/actions/notifications";
import { cn } from "@/lib/cn";

/**
 * The bell with the unread count. New notifications arrive live (Supabase Realtime, limited by RLS
 * to your own rows); if the socket is down it checks again every minute while the tab is open.
 */
export function NotificationBell({ initial, userId, className }: { initial: number; userId: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { session } = useSession();
  const [count, setCount] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setCount(initial);
  }

  // Read inside the realtime callback without resubscribing on every page change.
  const onPage = useRef(pathname === "/notifications");
  useEffect(() => {
    onPage.current = pathname === "/notifications";
  }, [pathname]);
  // The bell is rendered twice (desktop sidebar and phone header). Supabase returns the existing
  // channel for a topic that is already open, and adding a listener to a subscribed channel throws,
  // so each bell gets its own topic.
  const instance = useId();

  useEffect(() => {
    if (!session) return;
    const db = browserDb(() => session.getToken());
    const refresh = () => unreadNotifications().then(setCount).catch(() => {});
    let channel: ReturnType<NonNullable<typeof db>["channel"]> | null = null;
    try {
      channel =
        db
          ?.channel(`notifications:${userId}:${instance}`)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, () => {
            setCount((n) => n + 1);
            if (onPage.current) router.refresh();
          })
          .subscribe() ?? null;
    } catch {
      channel = null; // live updates are a nicety; the minute poll below still keeps the count right
    }
    const poll = setInterval(() => document.visibilityState === "visible" && refresh(), 60_000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      if (channel) db?.removeChannel(channel);
    };
  }, [session, userId, instance, router]);

  const active = pathname === "/notifications";
  return (
    <IntentLink
      href="/notifications"
      aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors",
        active ? "bg-ink text-surface" : "bg-surface text-ink ring-1 ring-inset ring-line hover:bg-white",
        className,
      )}
    >
      <Bell className="size-5" />
      {count > 0 && (
        <span className="num absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red px-1.5 text-[11px] font-bold text-white ring-2 ring-canvas">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </IntentLink>
  );
}
