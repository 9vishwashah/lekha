"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const KEY = "lekha:auto-retry";

/**
 * Most errors here are a momentary network or sign-in hiccup. The first one is retried quietly
 * (re-fetching the page from the server); the message only shows if that retry fails too.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY) ?? 0);
    } catch {}
    if (Date.now() - last > 15_000) {
      try {
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {}
      const t = setTimeout(() => retry(), 300);
      const reveal = setTimeout(() => setShow(true), 4_000);
      return () => {
        clearTimeout(t);
        clearTimeout(reveal);
      };
    }
    console.error(error);
    const t = setTimeout(() => setShow(true), 0);
    return () => clearTimeout(t);
  }, [error, retry]);

  if (!show) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3 py-16" role="status">
        <div className="h-12 w-2/3 animate-pulse rounded-2xl bg-ink/5" />
        <div className="h-5 w-full animate-pulse rounded-full bg-ink/5" />
        <div className="h-5 w-4/5 animate-pulse rounded-full bg-ink/5" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 py-16">
      <h1 className="display text-5xl font-extrabold">That didn’t load</h1>
      <p className="text-lg text-ink-2">
        We couldn’t reach your data just now. Nothing you saved is affected. Check your connection and try again.
      </p>
      <Button
        onClick={() => {
          setShow(false);
          retry();
          // If this boundary is still here after the retry, it failed again: show the message.
          setTimeout(() => setShow(true), 4_000);
        }}
        className="self-start"
        size="lg"
      >
        Try again
      </Button>
    </div>
  );
}
