import { getWorkspace } from "@/lib/server/context";
import { listContractors, listLedgers, walletsOf } from "@/lib/server/queries";
import { listInvoices } from "@/lib/server/invoices";
import { PageHeader } from "@/components/ui/bits";
import { UniversalComposer, type Tab } from "@/components/app/universal-composer";
import { toPaise } from "@/lib/domain/money";
import { todayISO } from "@/lib/domain/dates";

export const metadata = { title: "New entry" };

const TITLES: Record<Tab, string> = { paid: "Paid", received: "Received", book: "Book entry", transfer: "Transfer" };
const TABS = Object.keys(TITLES) as Tab[];

export default async function NewEntry(props: PageProps<"/entries/new">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const [contractors, ledgers, invoices, { data: categories }] = await Promise.all([
    listContractors(ctx.db, ctx.workspace.id),
    listLedgers(ctx.db, ctx.workspace.id),
    listInvoices(ctx.db, ctx.workspace.id),
    ctx.db.from("expense_categories").select("id, name").eq("workspace_id", ctx.workspace.id).order("name"),
  ]);
  const active = contractors.filter((c) => c.is_active);
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : "paid";
  const withClient = active.find((c) => c.id === params.with);
  const open = invoices
    .filter((i) => i.status === "issued" && i.invoice_type !== "proforma" && i.contractor_id && toPaise(i.grand_total) > toPaise(i.amount_received))
    .map((i) => ({ id: i.id, no: i.invoice_no ?? "Invoice", contractor_id: i.contractor_id!, balance: (toPaise(i.grand_total) - toPaise(i.amount_received)).toString() }));
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={TITLES[tab]} kicker={withClient?.name ?? ctx.workspace.name} />
      <UniversalComposer
        clients={active.map((c) => ({ id: c.id, name: c.name, kind: c.kind, phone: c.phone }))}
        wallets={walletsOf(ledgers)}
        categories={categories ?? []}
        invoices={open}
        today={todayISO()}
        initialTab={tab}
        lockTab
        initialSub={params.sub as never}
        withClient={withClient?.id}
      />
    </div>
  );
}
