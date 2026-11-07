import { getWorkspace } from "@/lib/server/context";
import { listContractors, listLedgers, walletsOf } from "@/lib/server/queries";
import { PageHeader } from "@/components/ui/bits";
import { ExpenseForm } from "@/components/app/expense-form";
import { todayISO } from "@/lib/domain/dates";

export const metadata = { title: "New expense" };

export default async function NewExpense(props: PageProps<"/expenses/new">) {
  const ctx = await getWorkspace();
  const { with: withParam } = (await props.searchParams) as { with?: string };
  const [{ data: categories }, contractors, ledgers] = await Promise.all([
    ctx.db.from("expense_categories").select("id, name").eq("workspace_id", ctx.workspace.id).order("name"),
    listContractors(ctx.db, ctx.workspace.id),
    listLedgers(ctx.db, ctx.workspace.id),
  ]);
  const active = contractors.filter((c) => c.is_active);
  const withClient = active.find((c) => c.id === withParam);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New expense" kicker={withClient?.name ?? "Expenses"} />
      <ExpenseForm
        categories={categories ?? []}
        contractors={active.map((c) => ({ id: c.id, name: c.name }))}
        clients={active.map((c) => ({ id: c.id, name: c.name, kind: c.kind, phone: c.phone }))}
        withClient={withClient?.id}
        ledgers={walletsOf(ledgers)}
        today={todayISO()}
      />
    </div>
  );
}
