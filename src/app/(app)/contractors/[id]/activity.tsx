"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Money } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { DateTile } from "@/components/ui/date-tile";
import { deleteRepayment, deleteSharedExpense } from "@/app/(app)/actions/records";
import { formatDate } from "@/lib/domain/dates";
import { cn } from "@/lib/cn";

export interface ActivityRow {
  key: string;
  date: string;
  title: string;
  from: string;
  /** + you gave (they owe you more), − you got. Paise as a string (props cross to the browser). */
  amount: string;
  void: boolean;
  /** Ledger and invoice rows open their own page. */
  href?: string;
  /** Expenses and payments with this person live on this page itself. */
  entry?: { kind: "expense" | "settlement"; id: string; ledgerId: string; mine: boolean; total?: string };
}

/** Everything with this person, one card per entry: this list is their account. */
export function ActivityList({ rows, today, first, canWrite }: { rows: ActivityRow[]; today: string; first: string; canWrite: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<ActivityRow | null>(null);
  const [pending, start] = useTransition();

  const card = (a: ActivityRow) => {
    const value = BigInt(a.amount);
    const got = value < 0n;
    const body = (
      <>
        <DateTile date={a.date} today={today} direction={got ? "in" : "out"} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-medium", a.void && "line-through opacity-50")}>{a.title}</span>
          <span className="block truncate text-[13px] text-ink-3">
            {a.from}
            {a.void ? " · void" : ""}
          </span>
        </span>
        <span className="text-right">
          <Money value={got ? -value : value} tone={got ? "in" : "out"} className={a.void ? "block line-through opacity-50" : "block font-semibold"} />
          <span className="text-[12px] text-ink-3">{got ? "You got" : "You gave"}</span>
        </span>
      </>
    );
    const cls = cn("flex w-full items-center gap-3 rounded-3xl p-4 text-left ring-1 ring-inset hover:brightness-[0.98]", got ? "bg-in-soft ring-in/20" : "bg-surface ring-line/70");
    return a.href && !a.entry ? (
      <Link href={a.href} className={cls}>
        {body}
      </Link>
    ) : (
      <button type="button" className={cls} onClick={() => setOpen(a)}>
        {body}
      </button>
    );
  };

  const remove = (a: ActivityRow) =>
    start(async () => {
      if (!a.entry) return;
      if (!window.confirm("Delete this entry? It is removed from both of your accounts and cannot be undone.")) return;
      const res = a.entry.kind === "expense" ? await deleteSharedExpense(a.entry.id, a.entry.ledgerId) : await deleteRepayment(a.entry.id, a.entry.ledgerId);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Deleted");
      setOpen(null);
      router.refresh();
    });

  return (
    <>
      <ul className="flex flex-col gap-2">
        {rows.map((a) => (
          <li key={a.key}>{card(a)}</li>
        ))}
      </ul>
      <Sheet open={Boolean(open)} onClose={() => setOpen(null)} title={open?.title ?? ""} description={open ? formatDate(open.date) : undefined}>
        {open && (
          <div className="flex flex-col gap-4 pb-2">
            <dl className="divide-y divide-line rounded-2xl bg-surface text-[15px] ring-1 ring-inset ring-line">
              <div className="flex justify-between gap-3 px-4 py-3">
                <dt className="text-ink-2">{BigInt(open.amount) < 0n ? "You got" : "You gave"}</dt>
                <dd>
                  <Money value={BigInt(open.amount) < 0n ? -BigInt(open.amount) : BigInt(open.amount)} className="font-semibold" />
                </dd>
              </div>
              {open.entry?.total && (
                <div className="flex justify-between gap-3 px-4 py-3">
                  <dt className="text-ink-2">Total bill</dt>
                  <dd>
                    <Money value={BigInt(open.entry.total)} />
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-3 px-4 py-3">
                <dt className="text-ink-2">Recorded</dt>
                <dd className="text-right">{open.from}</dd>
              </div>
            </dl>
            {open.entry?.mine && canWrite ? (
              <Button variant="danger" disabled={pending} onClick={() => remove(open)}>
                <Trash2 className="size-4" /> {pending ? "Deleting…" : "Delete entry"}
              </Button>
            ) : (
              <p className="text-[13px] text-ink-3">{first} added this in their Lekha, so only they can change it.</p>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}
