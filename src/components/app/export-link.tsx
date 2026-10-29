"use client";
import { type MouseEvent, type ReactNode, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";

const fileName = (res: Response, fallback: string) => /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallback;

/**
 * A download link for PDF, Excel and CSV exports. Building a file takes a moment, so a tap shows a
 * spinner and "Preparing…" until the file arrives, then saves it under the server's file name. The
 * href stays a real link: with JavaScript off, or opened in a new tab, it downloads as before.
 */
export function ExportLink({
  href,
  className,
  children,
  onDone,
  keepContent = false,
}: {
  href: string;
  className?: string;
  children: ReactNode;
  onDone?: () => void;
  /** For cards and rows: keep their content and show a "Preparing…" pill in the corner instead. */
  keepContent?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const download = async (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(href, { credentials: "same-origin" });
      if (!res.ok) throw new Error(res.status === 429 ? "Too many exports. Wait a minute and try again." : "The file could not be prepared. Try again.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName(res, "lekha-export");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`Downloaded ${a.download}`);
      onDone?.();
    } catch (err) {
      toast.error(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "No connection. Check your internet and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <a
      href={href}
      onClick={download}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      className={cn(className, keepContent && "relative", busy && "pointer-events-none")}
    >
      {keepContent ? (
        <>
          {children}
          {busy && (
            <span className="absolute right-3 top-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[13px] font-medium text-surface">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Preparing…
            </span>
          )}
        </>
      ) : busy ? (
        <>
          <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
          <span>Preparing…</span>
        </>
      ) : (
        children
      )}
    </a>
  );
}
