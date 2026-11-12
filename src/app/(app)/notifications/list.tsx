"use client";
import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownLeft, ArrowUpRight, BellOff, CheckCheck, CheckCircle2, Eye, FileWarning, HandCoins, Receipt, UserPlus, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeNotification, type NotificationRow } from "@/lib/notifications";
import { markNotificationsRead } from "@/app/(app)/actions/notifications";
import { relativeTime } from "@/lib/domain/dates";
import { cn } from "@/lib/cn";

const ICON = {
  entry: Wallet,
  expense: Receipt,
  payment: HandCoins,
  confirmed: CheckCircle2,
  invoice_viewed: Eye,
  invoice_claim: HandCoins,
  joined: UserPlus,
  invoice_overdue: FileWarning,
  advance_due: FileWarning,
} as const;

const TONE = {
  in: "bg-in-soft text-in",
  out: "bg-[#f6dcda] text-out",
  warn: "bg-mustard/25 text-ink",
  neutral: "bg-sunken text-ink",
} as const;

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

export function NotificationList({ rows }: { rows: NotificationRow[] }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [shown, markLocal] = useOptimistic(rows, (state, ids: number[] | "all") =>
    state.map((r) => (ids === "all" || ids.includes(r.id) ? { ...r, read_at: r.read_at ?? new Date().toISOString() } : r)),
  );
  const unread = shown.filter((r) => !r.read_at).length;

  const open = (r: NotificationRow) =>
    start(async () => {
      if (!r.read_at) {
        markLocal([r.id]);
        await markNotificationsRead([r.id]);
      }
      if (r.href) router.push(r.href);
    });

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed border-line p-10 text-center">
        <BellOff className="size-8 text-ink-3" />
        <p className="display text-2xl font-bold">You’re all caught up</p>
        <p className="max-w-sm text-ink-2">When someone adds money in or out with you, confirms a statement or opens an invoice, it shows up here.</p>
      </div>
    );
  }

  const groups = new Map<string, NotificationRow[]>();
  for (const r of shown) groups.set(dayLabel(r.created_at), [...(groups.get(dayLabel(r.created_at)) ?? []), r]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] text-ink-2">{unread > 0 ? `${unread} unread` : "All read"}</p>
        {unread > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              start(async () => {
                markLocal("all");
                await markNotificationsRead();
                router.refresh();
              })
            }
          >
            <CheckCheck className="size-4" /> Mark all read
          </Button>
        )}
      </div>
      {[...groups].map(([day, items]) => (
        <section key={day} aria-label={day} className="flex flex-col gap-2">
          <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wide text-ink-3">{day}</h2>
          <ul className="flex flex-col gap-2">
            {items.map((r) => {
              const d = describeNotification(r);
              const Icon = r.kind === "entry" ? (r.direction === "in" ? ArrowDownLeft : ArrowUpRight) : ICON[r.kind];
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => open(r)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-3xl p-4 text-left ring-1 ring-inset transition-colors",
                      r.read_at ? "bg-surface ring-line/70 hover:bg-white" : "bg-white ring-ink/15 shadow-[0_6px_20px_rgb(29_29_27/0.06)]",
                    )}
                  >
                    <span className={cn("inline-flex size-11 shrink-0 items-center justify-center rounded-2xl", TONE[d.tone])}>
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-[15px]", r.read_at ? "font-medium" : "font-semibold")}>{d.title}</span>
                      {d.body && <span className="mt-0.5 block truncate text-[14px] text-ink-2">{d.body}</span>}
                      <span className="mt-1 block text-[12px] text-ink-3">{relativeTime(r.created_at)}</span>
                    </span>
                    {!r.read_at && <span className="mt-2 size-2.5 shrink-0 rounded-full bg-red" aria-label="Unread" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
