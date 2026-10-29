import { getWorkspace } from "@/lib/server/context";
import { listContractors, listLedgers } from "@/lib/server/queries";
import { PageHeader } from "@/components/ui/bits";
import { ExpenseForm } from "@/components/app/expense-form";
import { todayISO } from "@/lib/domain/dates";

export const metadata = { title: "New expense" };

export default async function NewExpense() {
  const ctx = await getWorkspace();
  const [{ data: categories }, contractors, ledgers] = await Promise.all([
    ctx.db.from("expense_categories").select("id, name").eq("workspace_id", ctx.workspace.id).order("name"),
    listContractors(ctx.db, ctx.workspace.id),
    listLedgers(ctx.db, ctx.workspace.id),
  ]);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New expense" kicker="Expenses" />
      <ExpenseForm
        categories={categories ?? []}
        contractors={contractors.filter((c) => c.is_active).map((c) => ({ id: c.id, name: c.name }))}
        ledgers={ledgers.filter((l) => l.status === "active" && l.ledger_type !== "personal").map((l) => ({ id: l.id, name: l.name }))}
        today={todayISO()}
      />
    </div>
  );
}
