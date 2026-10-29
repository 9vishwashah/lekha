import { getWorkspace } from "@/lib/server/context";
import { listContractors } from "@/lib/server/queries";
import { PageHeader } from "@/components/ui/bits";
import { LedgerForm } from "@/components/app/ledger-form";
import { todayISO } from "@/lib/domain/dates";

export const metadata = { title: "New ledger" };

export default async function NewLedger(props: PageProps<"/ledgers/new">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const contractors = (await listContractors(ctx.db, ctx.workspace.id)).filter((c) => c.is_active);
  const type = ["basic", "taxation", "personal"].includes(params.type) ? params.type : "basic";
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New ledger" kicker="Ledgers" />
      <LedgerForm
        contractors={contractors.map((c) => ({ id: c.id, name: c.name, kind: c.kind, phone: c.phone }))}
        initialType={type as "basic" | "taxation" | "personal"}
        defaultContractor={params.contractor}
        defaultPeople={(params.people ?? "").split(",").filter((id) => contractors.some((c) => c.id === id))}
        defaultGstMode={ctx.workspace.default_gst_mode}
        today={todayISO()}
      />
    </div>
  );
}
