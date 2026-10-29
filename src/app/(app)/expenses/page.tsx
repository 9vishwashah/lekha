import { ExportLink } from "@/components/app/export-link";
import Link from "next/link";
import { Download, Plus } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { fetchAll } from "@/lib/server/queries";
import { PeriodTabs, resolvePeriod } from "@/components/app/period-tabs";
import { Amount, Money } from "@/components/ui/amount";
import { Badge, EmptyState, PageHeader } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { type Paise, sum, toPaise } from "@/lib/domain/money";
import { formatDateShort, monthLabel } from "@/lib/domain/dates";
import { paymentModeLabel } from "@/lib/types";

export const metadata = { title: "Expenses" };

interface Row {
  id: string;
  expense_date: string;
  title: string;
  amount: string;
  vendor: string | null;
  payment_mode: string | null;
  category_id: string;
  status: "active" | "void";
  ledger_id: string | null;
  contractor: { name: string } | null;
}

export default async function ExpensesPage(props: PageProps<"/expenses">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const period = resolvePeriod(params, ctx.workspace.fy_start_month);
  const category = params.category ?? "";
  const q = (params.q ?? "").trim().toLowerCase();

  const [{ data: categories }, rows] = await Promise.all([
    ctx.db.from("expense_categories").select("id, name").eq("workspace_id", ctx.workspace.id).order("name"),
    fetchAll<Row>((from, to) => {
      let query = ctx.db
        .from("expenses")
        .select("id, expense_date, title, amount, vendor, payment_mode, category_id, status, ledger_id, contractor:contractors(name)")
        .eq("workspace_id", ctx.workspace.id);
      if (period.range.from) query = query.gte("expense_date", period.range.from);
      if (period.range.to) query = query.lte("expense_date", period.range.to);
      if (category) query = query.eq("category_id", category);
      return query.order("expense_date", { ascending: false }).order("created_at", { ascending: false }).range(from, to);
    }),
  ]);
  const names = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const visible = rows.filter((r) => !q || r.title.toLowerCase().includes(q) || r.vendor?.toLowerCase().includes(q));
  const active = visible.filter((r) => r.status === "active");
  const total = sum(active.map((r) => toPaise(r.amount)));
  const byCategory = new Map<string, Paise>();
  const byMonth = new Map<string, Paise>();
  for (const r of active) {
    byCategory.set(r.category_id, (byCategory.get(r.category_id) ?? 0n) + toPaise(r.amount));
    byMonth.set(r.expense_date.slice(0, 7), (byMonth.get(r.expense_date.slice(0, 7)) ?? 0n) + toPaise(r.amount));
  }
  const categoryRanking = [...byCategory.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1));
  const exportQs = new URLSearchParams({ type: "expenses", ...(period.range.from && { from: period.range.from }), ...(period.range.to && { to: period.range.to }), ...(category && { category }) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Expenses"
        actions={
          <>
            <ExportLink href={`/api/export/report?${exportQs}&format=xlsx`} className="inline-flex h-12 items-center gap-2 rounded-full px-4 font-medium hover:bg-sunken">
              <Download className="size-4" /> Excel
            </ExportLink>
            <ExportLink href={`/api/export/report?${exportQs}&format=pdf`} className="inline-flex h-12 items-center gap-2 rounded-full px-4 font-medium hover:bg-sunken">
              PDF
            </ExportLink>
            <ExportLink href={`/api/export/report?${exportQs}&format=csv`} className="inline-flex h-12 items-center gap-2 rounded-full px-4 font-medium hover:bg-sunken">
              CSV
            </ExportLink>
            {ctx.canWrite && (
              <LinkButton href="/expenses/new">
                <Plus className="size-5" /> Add expense
              </LinkButton>
            )}
          </>
        }
      />
      <PeriodTabs basePath="/expenses" active={period.key} from={params.from} to={params.to} extra={category ? { category } : {}} />

      <div className="grid gap-3 lg:grid-cols-[1fr_1.4fr]">
        <div className="rounded-[var(--radius-card)] bg-sky p-6">
          <div className="text-sm font-semibold">Spent · {period.label.toLowerCase()}</div>
          <Amount value={total} size="xl" className="mt-6 block" />
          <div className="mt-1 text-sm opacity-70">{active.length} expenses{category ? ` in ${names.get(category)}` : ""}</div>
        </div>
        <div className="rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70">
          <h2 className="mb-3 text-sm font-semibold">By category</h2>
          {categoryRanking.length === 0 ? (
            <p className="text-ink-2">Nothing yet.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {categoryRanking.map(([id, amount]) => (
                <li key={id}>
                  <Link href={`/expenses?${new URLSearchParams({ ...params, category: id })}`} className="group block">
                    <div className="flex justify-between text-[15px]">
                      <span className="font-medium group-hover:underline">{names.get(id)}</span>
                      <Money value={amount} className="font-semibold" />
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-sunken">
                      <div className="h-full rounded-full bg-ink" style={{ width: `${total ? Number((amount * 1000n) / total) / 10 : 0}%` }} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {byMonth.size > 1 && (
        <section aria-label="Monthly totals" className="flex flex-wrap gap-2">
          {[...byMonth.entries()].sort().map(([m, amount]) => (
            <span key={m} className="rounded-full bg-surface px-4 py-2 text-sm ring-1 ring-inset ring-line">
              {monthLabel(m)} · <Money value={amount} className="font-semibold" />
            </span>
          ))}
        </section>
      )}

      <form action="/expenses" className="flex flex-col gap-2 sm:flex-row">
        {Object.entries(params)
          .filter(([k]) => k !== "q" && k !== "category")
          .map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        <label htmlFor="eq" className="sr-only">
          Search expenses
        </label>
        <input id="eq" name="q" defaultValue={params.q} placeholder="Search title or vendor" className="h-12 rounded-full bg-surface px-5 text-[16px] ring-1 ring-inset ring-line sm:w-72" />
        <label htmlFor="ecat" className="sr-only">
          Category
        </label>
        <select id="ecat" name="category" defaultValue={category} className="h-12 rounded-full bg-surface px-4 ring-1 ring-inset ring-line">
          <option value="">All categories</option>
          {(categories ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit" className="h-12 rounded-full px-5 font-medium ring-1 ring-inset ring-line hover:bg-surface">
          Filter
        </button>
      </form>

      {visible.length === 0 ? (
        <EmptyState
          title="No expenses here"
          body="Record materials, labour, transport and anything else you spend. Paid from a ledger? Pick it and the ledger updates too."
          action={ctx.canWrite ? <LinkButton href="/expenses/new">Add expense</LinkButton> : undefined}
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
          {visible.map((r) => (
            <li key={r.id}>
              <Link href={`/expenses/${r.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-white sm:px-5">
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-medium ${r.status === "void" ? "line-through opacity-50" : ""}`}>{r.title}</span>
                  <span className="block truncate text-[13px] text-ink-3">
                    {formatDateShort(r.expense_date, period.today)} · {names.get(r.category_id)}
                    {r.vendor && ` · ${r.vendor}`}
                    {r.payment_mode && ` · ${paymentModeLabel(r.payment_mode)}`}
                    {r.contractor && ` · for ${r.contractor.name}`}
                  </span>
                </span>
                {r.ledger_id && <Badge className="hidden sm:inline-flex">In ledger</Badge>}
                {r.status === "void" && <Badge>void</Badge>}
                <Money value={toPaise(r.amount)} className="font-semibold" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
