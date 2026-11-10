"use client";
import { useDeferredValue, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";

/**
 * Search on a shared statement. The rows are already on the page, so filtering happens in the
 * browser: instant, and nothing extra is sent to the server.
 */
export function SharedSearch({ items }: { items: { key: string; text: string; node: ReactNode }[] }) {
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());
  const digits = q.replace(/[₹,\s]/g, "");
  const shown = q
    ? items.filter((i) => i.text.includes(q) || (/^\d+(\.\d*)?$/.test(digits) && i.text.includes(digits.replace(/\.$/, ""))))
    : items;

  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">Search entries</span>
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search payee, description or amount"
          className="h-12 w-full rounded-full bg-surface pl-11 pr-11 text-[15px] ring-1 ring-inset ring-line outline-none placeholder:text-ink-3 focus:ring-2 focus:ring-ink"
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-2 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 hover:text-ink">
            <X className="size-4" />
          </button>
        )}
      </label>
      {q && (
        <p className="px-1 text-[13px] text-ink-3" role="status">
          {shown.length} of {items.length} {items.length === 1 ? "entry" : "entries"}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border-2 border-dashed border-line p-8 text-center text-ink-2">Nothing matches “{query.trim()}”.</p>
      ) : (
        <ul className="flex flex-col gap-2">{shown.map((i) => i.node)}</ul>
      )}
    </div>
  );
}
