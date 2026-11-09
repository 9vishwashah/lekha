import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { listContractors, listLedgers } from "@/lib/server/queries";
import { Badge, PageHeader } from "@/components/ui/bits";
import { ExpenseForm, type ExpenseValues } from "@/components/app/expense-form";
import { DeleteExpense } from "./void";
import { todayISO } from "@/lib/domain/dates";

export const metadata = { title: "Expense" };

export default async function ExpensePage(props: PageProps<"/expenses/[id]">) {
  const ctx = await getWorkspace();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [{ data: expense }, { data: categories }, contractors, ledgers] = await Promise.all([
    ctx.db.from("expenses").select("*").eq("id", id).eq("workspace_id", ctx.workspace.id).maybeSingle(),
    ctx.db.from("expense_categories").select("id, name").eq("workspace_id", ctx.workspace.id).order("name"),
    listContractors(ctx.db, ctx.workspace.id),
    listLedgers(ctx.db, ctx.workspace.id),
  ]);
  if (!expense) notFound();
  const isVoid = expense.status === "void";

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/expenses" className="inline-flex h-11 items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Expenses
      </Link>
      <PageHeader title={expense.title} actions={isVoid ? <Badge>Void</Badge> : undefined}>
        {isVoid && <p className="mt-2 text-ink-2">Voided: {expense.void_reason}</p>}
      </PageHeader>
      {isVoid || !ctx.canWrite ? (
        <p className="text-ink-2">This expense can no longer be changed.</p>
      ) : expense.split_group_id ? (
        <>
          <p className="rounded-2xl bg-sunken p-4 text-ink-2">
            This is your share of an expense split with other people. To change it, delete it and add it again, so every person&apos;s share stays correct.
          </p>
          <DeleteExpense id={expense.id} linked split />
        </>
      ) : (
        <>
          <ExpenseForm
            expense={expense as ExpenseValues}
            categories={categories ?? []}
            contractors={contractors.map((c) => ({ id: c.id, name: c.name }))}
            ledgers={ledgers.map((l) => ({ id: l.id, name: l.name, kind: l.wallet_kind }))}
            today={todayISO()}
          />
          <DeleteExpense id={expense.id} linked={Boolean(expense.transaction_id)} />
        </>
      )}
    </div>
  );
}
