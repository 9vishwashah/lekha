/** Wordmark: a ledger "page" folded like a wallet card, set beside the name. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
        <rect x="1" y="5" width="28" height="22" rx="7" fill="#1d1d1b" />
        <rect x="1" y="3" width="20" height="12" rx="5" fill="#eac119" />
        <circle cx="22" cy="17" r="2.6" fill="#eae4da" />
      </svg>
      {!compact && <span className="display text-[1.65rem] font-extrabold">lekha</span>}
      {compact && <span className="display text-2xl font-extrabold">lekha</span>}
    </span>
  );
}
