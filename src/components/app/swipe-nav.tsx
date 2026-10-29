"use client";
import { type ReactNode, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

/** Main sections in the order they sit in the navigation. Swiping moves between neighbours. */
export const SWIPE_ORDER = ["/dashboard", "/ledgers", "/contractors", "/expenses", "/advances", "/reports"];

// Shared between the gesture and the page that mounts after navigation.
let lastIndex = -1;
let pendingDirection: "next" | "prev" | null = null;

function blocksSwipe(target: EventTarget | null) {
  let el = target as HTMLElement | null;
  while (el && el !== document.body) {
    if (el.matches("input, textarea, select, [contenteditable], dialog, [data-no-swipe]")) return true;
    const style = getComputedStyle(el);
    if ((style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) return true;
    el = el.parentElement;
  }
  return Boolean(document.querySelector("dialog[open]"));
}

/**
 * Phone gesture: swipe left for the next section, right for the previous one. The page follows the
 * finger with resistance, then the next page slides in from that side. Only on the main sections,
 * never over scrollable rows, open sheets or form fields, and it turns off with reduced motion.
 */
export function SwipeNav({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const index = SWIPE_ORDER.indexOf(pathname);
  const pane = useRef<HTMLDivElement>(null);

  // Direction for the entering page: from the swipe, or from the position of the tapped tab.
  const direction = pendingDirection ?? (lastIndex >= 0 && index >= 0 && index !== lastIndex ? (index > lastIndex ? "next" : "prev") : null);
  useEffect(() => {
    pendingDirection = null;
    if (index >= 0) lastIndex = index;
  }, [index]);

  // Warm the neighbours' skeletons so a swipe responds instantly (the default prefetch stops at the
  // loading boundary, so this does not render whole pages in the background).
  useEffect(() => {
    if (index < 0) return;
    for (const i of [index - 1, index + 1]) if (SWIPE_ORDER[i]) router.prefetch(SWIPE_ORDER[i]);
  }, [index, router]);

  useEffect(() => {
    const el = pane.current;
    if (!el || index < 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;

    let startX = 0;
    let startY = 0;
    let startT = 0;
    let axis: "x" | "y" | null = null;
    let active = false;
    let dx = 0;

    const reset = (animate: boolean) => {
      el.style.transition = animate ? "transform 220ms cubic-bezier(0.2,0.8,0.2,1), opacity 220ms" : "";
      el.style.transform = "";
      el.style.opacity = "";
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || blocksSwipe(e.target)) {
        active = false;
        return;
      }
      active = true;
      axis = null;
      dx = 0;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startT = performance.now();
      el.style.transition = "";
    };

    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const x = e.touches[0].clientX - startX;
      const y = e.touches[0].clientY - startY;
      if (!axis) {
        if (Math.abs(x) < 10 && Math.abs(y) < 10) return;
        axis = Math.abs(x) > Math.abs(y) * 1.3 ? "x" : "y";
      }
      if (axis !== "x") return;
      const target = x < 0 ? SWIPE_ORDER[index + 1] : SWIPE_ORDER[index - 1];
      // Rubber band at the ends, gentle follow otherwise.
      dx = target ? x * 0.45 : x * 0.12;
      el.style.transform = `translate3d(${dx}px,0,0)`;
      el.style.opacity = String(1 - Math.min(Math.abs(dx) / 600, 0.25));
    };

    const onEnd = (e: TouchEvent) => {
      if (!active || axis !== "x") {
        active = false;
        return;
      }
      active = false;
      const x = (e.changedTouches[0]?.clientX ?? startX) - startX;
      const velocity = Math.abs(x) / Math.max(performance.now() - startT, 1);
      const next = x < 0 ? SWIPE_ORDER[index + 1] : SWIPE_ORDER[index - 1];
      if (next && (Math.abs(x) > 90 || (Math.abs(x) > 40 && velocity > 0.45))) {
        pendingDirection = x < 0 ? "next" : "prev";
        el.style.transition = "transform 160ms ease-in, opacity 160ms ease-in";
        el.style.transform = `translate3d(${x < 0 ? -48 : 48}px,0,0)`;
        el.style.opacity = "0";
        if ("vibrate" in navigator) navigator.vibrate?.(8);
        router.push(next, { scroll: true });
      } else {
        reset(true);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", () => reset(true), { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      reset(false);
    };
  }, [index, router]);

  return (
    <div
      ref={pane}
      key={pathname}
      className={cn("min-w-0 will-change-auto", direction === "next" && "animate-enter-next", direction === "prev" && "animate-enter-prev")}
    >
      {children}
    </div>
  );
}
