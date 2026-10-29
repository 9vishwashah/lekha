import { IntentLink } from "@/components/app/intent-link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Amount } from "@/components/ui/amount";
import { walletOf } from "@/components/ui/bits";
import { cn } from "@/lib/cn";

const TYPE_LABEL: Record<string, string> = { basic: "Basic ledger", taxation: "Taxation ledger", personal: "Shared account" };

/** A ledger as a solid-colour wallet card. The balance is the hero; the meaning sits under it. */
export function WalletCard({
  href,
  color,
  name,
  subtitle,
  type,
  balance,
  meaning,
  chips = [],
  archived,
  footer,
}: {
  href: string;
  color: string;
  name: string;
  subtitle?: string | null;
  type: string;
  balance: bigint | null;
  meaning: string;
  chips?: string[];
  archived?: boolean;
  footer?: ReactNode;
}) {
  const w = walletOf(color);
  return (
    <IntentLink
      href={href}
      className={cn(
        "group relative flex min-h-56 flex-col justify-between overflow-hidden rounded-[var(--radius-card)] p-5 transition-transform active:scale-[0.99] sm:p-6",
        w.bg,
        w.fg,
        archived && "opacity-60 saturate-50",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={cn("text-[13px] font-medium", w.sub)}>{TYPE_LABEL[type] ?? type}</div>
          <div className="mt-0.5 truncate text-lg font-semibold">{name}</div>
          {subtitle && <div className={cn("truncate text-sm", w.sub)}>{subtitle}</div>}
        </div>
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-white/80 text-ink transition-transform group-hover:rotate-45">
          <ArrowUpRight className="size-5" />
        </span>
      </div>
      <div className="min-w-0">
        {balance !== null ? (
          <Amount value={balance < 0n ? -balance : balance} size="lg" className="block truncate text-[2rem] sm:text-[2.4rem]" />
        ) : (
          <div className="display text-2xl font-bold">Open to see balances</div>
        )}
        <div className={cn("mt-1 text-sm font-medium", w.sub)}>{meaning}</div>
        {(chips.length > 0 || footer) && (
          <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-medium">
            {chips.map((c) => (
              <span key={c} className={cn("rounded-full px-2.5 py-1", w.chip)}>
                {c}
              </span>
            ))}
            {footer}
          </div>
        )}
      </div>
    </IntentLink>
  );
}
