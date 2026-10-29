"use client";
import { type MouseEvent, type ReactNode, createContext, use, useCallback, useOptimistic, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

interface PendingNav {
  pending: boolean;
  /** Navigate inside a transition. `before` runs first in the same transition (for optimistic state). */
  go: (href: string, opts?: { replace?: boolean; before?: () => void }) => void;
}

const Ctx = createContext<PendingNav | null>(null);

/**
 * Filters change the URL and the server re-renders the page. While that happens the control the
 * person tapped switches at once (optimistic), and the page fades slightly after a short delay so a
 * slow network still shows that something is happening. A fast response never flickers.
 */
export function PendingNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = useCallback<PendingNav["go"]>(
    (href, { replace = false, before } = {}) =>
      start(() => {
        before?.();
        if (replace) router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
      }),
    [router],
  );
  return (
    <Ctx value={{ pending, go }}>
      <div
        aria-busy={pending || undefined}
        data-pending={pending || undefined}
        className="transition-opacity duration-200 data-[pending]:opacity-55 data-[pending]:delay-150"
      >
        {children}
      </div>
    </Ctx>
  );
}

export function usePendingNav(): PendingNav {
  const ctx = use(Ctx);
  const router = useRouter();
  const [pending, start] = useTransition();
  if (ctx) return ctx;
  // Outside the app shell (no provider): same behaviour without the page fade.
  return {
    pending,
    go: (href, { replace = false, before } = {}) =>
      start(() => {
        before?.();
        if (replace) router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
      }),
  };
}

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * Pill filter chips (period, status, "show"). Still real links, so they work without JavaScript and
 * open in a new tab; a plain tap flips the active chip immediately and loads in the background.
 */
export function FilterChips({
  label,
  items,
  active,
  className,
}: {
  label: string;
  items: { key: string; href: string; label: ReactNode }[];
  active: string;
  className?: string;
}) {
  const { go } = usePendingNav();
  const [shown, setShown] = useOptimistic(active);
  return (
    <nav aria-label={label} className={cn("flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-sunken p-1 [scrollbar-width:none]", className)}>
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          scroll={false}
          aria-current={shown === i.key ? "true" : undefined}
          onClick={(e) => {
            if (!plainClick(e)) return;
            e.preventDefault();
            if (i.key !== shown) go(i.href, { before: () => setShown(i.key) });
          }}
          className={cn(
            "inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors duration-100",
            shown === i.key ? "bg-ink text-surface" : "text-ink-2 hover:text-ink",
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
