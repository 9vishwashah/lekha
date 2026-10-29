import { getWorkspace } from "@/lib/server/context";
import { listContractors, listLedgers } from "@/lib/server/queries";
import { PageHeader, EmptyState } from "@/components/ui/bits";
import { LinkButton } from "@/components/ui/button";
import { AdvanceForm } from "./form";
import { todayISO } from "@/lib/domain/dates";

export const metadata = { title: "Give advance" };

export default async function NewAdvance(props: PageProps<"/advances/new">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const [contractors, ledgers] = await Promise.all([listContractors(ctx.db, ctx.workspace.id), listLedgers(ctx.db, ctx.workspace.id)]);
  const active = contractors.filter((c) => c.is_active);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Give advance" kicker="Advances" />
      {active.length === 0 ? (
        <EmptyState title="Add a client first" body="Advances are always given to someone. Add them in Client Accounts, then come back." action={<LinkButton href="/contractors">Go to Client Accounts</LinkButton>} />
      ) : (
        <AdvanceForm
          contractors={active.map((c) => ({ id: c.id, name: c.name }))}
          ledgers={ledgers.filter((l) => l.status === "active" && l.ledger_type !== "personal").map((l) => ({ id: l.id, name: l.name, contractor_id: l.contractor_id }))}
          defaultContractor={params.contractor}
          today={todayISO()}
        />
      )}
    </div>
  );
}
