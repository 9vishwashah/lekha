import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { listContractors, listLedgers } from "@/lib/server/queries";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { todayISO } from "@/lib/domain/dates";
import { PaymentPageForm } from "./form";

export const metadata = { title: "Record payment" };

export default async function RecordPayment() {
  const ctx = await getWorkspace();
  if (!ctx.canWrite) redirect("/contractors");
  const [contractors, ledgers] = await Promise.all([listContractors(ctx.db, ctx.workspace.id), listLedgers(ctx.db, ctx.workspace.id)]);
  const clients = contractors.filter((c) => c.is_active).map((c) => ({ id: c.id, name: c.name }));
  return (
    <div className="mx-auto max-w-xl">
      <Link href="/contractors" className="inline-flex h-11 items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Client Accounts
      </Link>
      <PageHeader title="Record payment" />
      {clients.length === 0 ? (
        <EmptyState title="No client accounts yet" body="Add someone first, then record money between you." action={<LinkButton href="/contractors">Add a client</LinkButton>} />
      ) : (
        <PaymentPageForm
          clients={clients}
          cashLedgers={ledgers.filter((l) => l.status === "active" && l.perspective === "cashbook").map((l) => ({ id: l.id, name: l.name }))}
          today={todayISO()}
        />
      )}
    </div>
  );
}
