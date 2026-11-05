import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { getInvoiceSettings, listLibrary, listPaymentProfiles } from "@/lib/server/invoices";
import { listContractors, listLedgers } from "@/lib/server/queries";
import { blankDraft } from "@/lib/invoices/editor";
import { invoiceTypeLabel } from "@/lib/domain/invoice";
import { todayISO } from "@/lib/domain/dates";
import { PageHeader } from "@/components/ui/bits";
import { InvoiceEditor } from "@/components/app/invoice/invoice-editor";

export const metadata = { title: "New invoice" };

export default async function CreateInvoice(props: PageProps<"/invoices/new/create">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const [settings, profiles, clients, ledgers, library] = await Promise.all([
    getInvoiceSettings(ctx.db, ctx.workspace.id, ctx.workspace.name),
    listPaymentProfiles(ctx.db, ctx.workspace.id),
    listContractors(ctx.db, ctx.workspace.id),
    listLedgers(ctx.db, ctx.workspace.id),
    listLibrary(ctx.db, ctx.workspace.id),
  ]);
  const initial = blankDraft(params.type ?? "service", settings, profiles, todayISO());
  return (
    <div className="flex flex-col gap-4">
      <Link href="/invoices/new" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Back
      </Link>
      <PageHeader title={invoiceTypeLabel(initial.invoice_type)} />
      <InvoiceEditor
        initial={initial}
        settings={settings}
        profiles={profiles}
        clients={clients.filter((c) => c.is_active).map((c) => ({ id: c.id, name: c.name, business_name: c.business_name, phone: c.phone, email: c.email, address: c.address }))}
        ledgers={ledgers.filter((l) => l.ledger_type !== "personal" && l.status === "active").map((l) => ({ id: l.id, name: l.name, contractor_id: l.contractor_id }))}
        library={library}
      />
    </div>
  );
}
