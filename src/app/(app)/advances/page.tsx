import { ExportLink } from "@/components/app/export-link";
import { IntentLink } from "@/components/app/intent-link";
import { FilterChips } from "@/components/app/pending-nav";
import { Download, Plus } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { advancesWithPositions } from "@/lib/server/workspace-data";
import { Amount, Money } from "@/components/ui/amount";
import { Badge, EmptyState, PageHeader } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { ADVANCE_STATUS_LABEL } from "@/lib/domain/advances";
import { sum } from "@/lib/domain/money";
import { formatDateShort, todayISO } from "@/lib/domain/dates";

export const metadata = { title: "Advances" };

const FILTERS = [
  { key: "open", label: "Outstanding" },
  { key: "overdue", label: "Overdue" },
  { key: "closed", label: "Settled" },
  { key: "all", label: "All" },
];

export default async function AdvancesPage(props: PageProps<"/advances">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const filter = FILTERS.some((f) => f.key === params.show) ? params.show : "open";
  const today = todayISO();
  const all = await advancesWithPositions(ctx.db, ctx.workspace.id, today);
  const active = all.filter((a) => a.status === "active");
  const list = all.filter((a) =>
    filter === "open"
      ? a.status === "active" && a.position.outstanding > 0n
      : filter === "overdue"
        ? a.position.overdue
        : filter === "closed"
          ? a.status === "active" && a.position.outstanding === 0n
          : true,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Advances"
        actions={
          <>
            <ExportLink href="/api/export/report?type=advances&format=xlsx" className="inline-flex h-12 items-center gap-2 rounded-full px-4 font-medium hover:bg-sunken">
              <Download className="size-4" /> Excel
            </ExportLink>
            <ExportLink href="/api/export/report?type=advances&format=pdf" className="inline-flex h-12 items-center rounded-full px-4 font-medium hover:bg-sunken">
              PDF
            </ExportLink>
            {ctx.canWrite && (
              <LinkButton href="/advances/new">
                <Plus className="size-5" /> Give advance
              </LinkButton>
            )}
          </>
        }
      >
        <p className="mt-3 max-w-2xl text-ink-2">
          Money given ahead of work. It is owed back to you until it is recovered in cash or adjusted against the contractor’s bill. It is not counted as
          an expense.
        </p>
      </PageHeader>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Advance totals">
        <div className="col-span-2 rounded-[var(--radius-card)] bg-pink p-6 lg:col-span-1">
          <div className="text-sm font-semibold">Outstanding</div>
          <Amount value={sum(active.map((a) => a.position.outstanding))} size="xl" className="mt-6 block" />
        </div>
        {[
          { label: "Given", v: sum(active.map((a) => a.position.amount)) },
          { label: "Recovered in cash", v: sum(active.map((a) => a.position.recovered)) },
          { label: "Adjusted in bills", v: sum(active.map((a) => a.position.adjusted)) },
        ].map((s) => (
          <div key={s.label} className="rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70">
            <div className="text-sm font-medium text-ink-2">{s.label}</div>
            <Amount value={s.v} size="lg" className="mt-4 block text-[1.5rem] sm:text-[2rem]" />
          </div>
        ))}
      </section>

      <FilterChips
        label="Filter advances"
        active={filter}
        items={FILTERS.map((f) => ({ key: f.key, href: `/advances?show=${f.key}`, label: f.label }))}
      />

      {list.length === 0 ? (
        <EmptyState
          title={filter === "open" ? "Nothing outstanding" : "No advances here"}
          body="When you give a contractor money before the work is billed, record it here. Then log cash coming back or adjust it against their bill."
          action={ctx.canWrite ? <LinkButton href="/advances/new">Give advance</LinkButton> : undefined}
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.map((a) => {
            const pct = a.position.amount > 0n ? Number(((a.position.amount - a.position.outstanding) * 100n) / a.position.amount) : 0;
            return (
              <li key={a.id}>
                <IntentLink href={`/advances/${a.id}`} className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 hover:bg-white">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-lg font-semibold">{a.contractor?.name}</div>
                      <div className="truncate text-sm text-ink-3">
                        {a.purpose || "Advance"} · given {formatDateShort(a.given_date, today)}
                      </div>
                    </div>
                    <Badge tone={a.status === "void" ? "neutral" : a.position.overdue ? "out" : a.position.outstanding === 0n ? "in" : "warn"}>
                      {a.position.overdue ? "Overdue" : ADVANCE_STATUS_LABEL[a.position.status]}
                    </Badge>
                  </div>
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <div className="text-[13px] text-ink-3">Outstanding</div>
                      <Amount value={a.position.outstanding} size="md" />
                    </div>
                    <div className="text-right text-[13px] text-ink-3">
                      of <Money value={a.position.amount} />
                      {a.expected_recovery_date && <div>due {formatDateShort(a.expected_recovery_date, today)}</div>}
                    </div>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${pct}% recovered or adjusted`}>
                    <div className="h-full rounded-full bg-tea" style={{ width: `${pct}%` }} />
                  </div>
                </IntentLink>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
