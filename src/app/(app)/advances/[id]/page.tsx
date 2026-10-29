import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { advancesWithPositions } from "@/lib/server/workspace-data";
import { Amount, Money } from "@/components/ui/amount";
import { Badge, Card, SectionTitle } from "@/components/ui/bits";
import { ADVANCE_STATUS_LABEL } from "@/lib/domain/advances";
import { toPaise } from "@/lib/domain/money";
import { formatDate, todayISO } from "@/lib/domain/dates";
import { paymentModeLabel } from "@/lib/types";
import { AllocationForm, VoidAdvance, VoidAllocation } from "./client";

export const metadata = { title: "Advance" };

export default async function AdvancePage(props: PageProps<"/advances/[id]">) {
  const ctx = await getWorkspace();
  const { id } = await props.params;
  const today = todayISO();
  const advance = (await advancesWithPositions(ctx.db, ctx.workspace.id, today)).find((a) => a.id === id);
  if (!advance) notFound();
  const { position: pos } = advance;
  const [{ data: bills }, { data: ledger }] = await Promise.all([
    advance.ledger_id
      ? ctx.db.from("transactions").select("id, voucher_no, txn_date, amount, description").eq("ledger_id", advance.ledger_id).eq("kind", "invoice").eq("status", "posted").order("txn_date", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as { id: string; voucher_no: string; txn_date: string; amount: string; description: string | null }[] }),
    advance.ledger_id ? ctx.db.from("ledgers").select("id, name").eq("id", advance.ledger_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const history = [...advance.allocations].sort((a, b) => (a.alloc_date === b.alloc_date ? (a.created_at < b.created_at ? -1 : 1) : a.alloc_date < b.alloc_date ? -1 : 1));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <Link href="/advances" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Advances
      </Link>

      <section className="rounded-[32px] bg-pink p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-ink/65">Advance to</div>
            <Link href={`/contractors/${advance.contractor_id}`} className="display text-[2.4rem] font-extrabold hover:underline sm:text-5xl">
              {advance.contractor?.name}
            </Link>
          </div>
          <Badge tone={advance.status === "void" ? "neutral" : pos.overdue ? "out" : pos.outstanding === 0n ? "in" : "ink"}>
            {pos.overdue ? "Overdue" : ADVANCE_STATUS_LABEL[pos.status]}
          </Badge>
        </div>
        <div className="mt-10 text-[15px] font-semibold">Still to come back</div>
        <Amount value={pos.outstanding} size="hero" className="block" />
        <dl className="mt-8 grid grid-cols-3 gap-3 text-ink">
          <div>
            <dt className="text-[13px] text-ink/65">Given</dt>
            <dd><Amount value={pos.amount} size="sm" /></dd>
          </div>
          <div>
            <dt className="text-[13px] text-ink/65">Recovered</dt>
            <dd><Amount value={pos.recovered} size="sm" /></dd>
          </div>
          <div>
            <dt className="text-[13px] text-ink/65">Adjusted</dt>
            <dd><Amount value={pos.adjusted} size="sm" /></dd>
          </div>
        </dl>
      </section>

      <Card>
        <dl className="divide-y divide-line text-[15px]">
          {[
            ["Given on", formatDate(advance.given_date)],
            ["Expected back", advance.expected_recovery_date ? formatDate(advance.expected_recovery_date) : "Not set"],
            ["Purpose", advance.purpose],
            ["Payment mode", paymentModeLabel(advance.payment_mode)],
            ["Reference", advance.reference_no],
            ["Ledger", ledger ? <Link key="l" href={`/ledgers/${ledger.id}`} className="underline">{ledger.name}</Link> : "Tracked on its own"],
          ]
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={String(k)} className="flex justify-between gap-4 py-2.5">
                <dt className="text-ink-2">{k}</dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
        </dl>
      </Card>

      {ctx.canWrite && advance.status === "active" && pos.outstanding > 0n && (
        <section>
          <SectionTitle className="mb-4">Record recovery</SectionTitle>
          <AllocationForm
            advanceId={advance.id}
            outstanding={pos.outstanding.toString()}
            today={today}
            hasLedger={Boolean(advance.ledger_id)}
            bills={(bills ?? []).map((b) => ({ id: b.id, label: `${b.voucher_no} · ${formatDate(b.txn_date)} · ${b.description ?? ""} · ₹${b.amount}` }))}
          />
        </section>
      )}

      <section>
        <SectionTitle className="mb-4">History</SectionTitle>
        {history.length === 0 ? (
          <p className="text-ink-2">Nothing recovered or adjusted yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <span className="min-w-0 flex-1">
                  <span className={`block font-medium ${h.status === "void" ? "line-through opacity-50" : ""}`}>
                    {h.kind === "recovery" ? "Cash recovered" : "Adjusted against bill"}
                    {h.bill_reference ? ` · ${h.bill_reference}` : ""}
                  </span>
                  <span className="block text-[13px] text-ink-3">
                    {formatDate(h.alloc_date)}
                    {h.status === "void" && ` · voided: ${h.void_reason}`}
                  </span>
                </span>
                <Money value={toPaise(h.amount)} tone={h.kind === "recovery" ? "in" : undefined} className="font-semibold" />
                {ctx.canWrite && h.status === "active" && <VoidAllocation id={h.id} advanceId={advance.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      {ctx.canWrite && advance.status === "active" && <VoidAdvance id={advance.id} hasActiveAllocations={advance.allocations.some((a) => a.status === "active")} />}
    </div>
  );
}
