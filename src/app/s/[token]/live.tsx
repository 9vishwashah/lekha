"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { relativeTime } from "@/lib/domain/dates";
import { cn } from "@/lib/cn";

/**
 * Keeps a public statement current without a new link. Polls a tiny "version" endpoint every
 * 15 seconds while the tab is visible and re-renders from the server when the ledger changes.
 * Backs off when offline or rate-limited, and stops if the link is revoked.
 */
export function SharedLive({ token, version }: { token: string; version: string }) {
  const router = useRouter();
  const [state, setState] = useState<"live" | "offline" | "revoked">("live");
  const [, tick] = useState(0);
  const current = useRef(version);
  useEffect(() => {
    current.current = version;
  }, [version]);

  useEffect(() => {
    let delay = 15_000;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const check = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/share/${token}?version=1`, { cache: "no-store" });
          if (res.status === 404) {
            setState("revoked");
            router.refresh();
            return;
          }
          if (!res.ok) throw new Error(String(res.status));
          const json = (await res.json()) as { version: string };
          setState("live");
          delay = 15_000;
          if (json.version !== current.current) router.refresh();
        } catch {
          setState("offline");
          delay = Math.min(delay * 2, 120_000);
        }
      }
      if (!stopped) timer = setTimeout(check, delay);
    };
    timer = setTimeout(check, delay);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, router]);

  return (
    <span role="status" className="inline-flex items-center gap-2 text-[13px] text-ink-2">
      <span className={cn("size-2 rounded-full", state === "live" ? "bg-in" : state === "offline" ? "animate-pulse bg-mustard" : "bg-red")} aria-hidden />
      {state === "revoked" ? "Link turned off" : state === "offline" ? "Reconnecting…" : `Updated ${relativeTime(version)}`}
    </span>
  );
}
