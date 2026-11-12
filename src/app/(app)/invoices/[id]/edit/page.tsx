import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { clientLogos, getInvoice, getInvoiceSettings, listLibrary, listPaymentProfiles } from "@/lib/server/invoices";
import { isUuid, listContractors, listLedgers } from "@/lib/server/queries";
import { draftFromRow } from "@/lib/invoices/editor";
import { PageHeader } from "@/components/ui/bits";
import { InvoiceEditor } from "@/components/app/invoice/invoice-editor";

export const metadata = { title: "Edit invoice" };

export default async function EditInvoice(props: PageProps<"/invoices/[id]/edit">) {
  const ctx = await getWorkspace();
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const data = await getInvoice(ctx.db, id);
  if (!data) notFound();
  // Drafts and issued invoices can be edited; a cancelled one cannot (duplicate it instead).
  if (data.invoice.status === "cancelled" || !ctx.canWrite) redirect(`/invoices/${id}`);
  const issued = data.invoice.status === "issued";
  const [settings, profiles, clients, ledgers, library, logos] = await Promise.all([
    getInvoiceSettings(ctx.db, ctx.workspace.id, ctx.workspace.name),
    listPaymentProfiles(ctx.db, ctx.workspace.id),
    listContractors(ctx.db, ctx.workspace.id),
    listLedgers(ctx.db, ctx.workspace.id),
    listLibrary(ctx.db, ctx.workspace.id),
    clientLogos(ctx.db, ctx.workspace.id),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <Link href={`/invoices/${id}`} className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> {issued ? data.invoice.invoice_no ?? "Invoice" : "Draft details"}
      </Link>
      <PageHeader title={issued ? `Edit ${data.invoice.invoice_no ?? "invoice"}` : "Edit draft"}>
        {issued && (
          <p className="mt-3 max-w-2xl text-ink-2">
            The number, share link and payments stay. The ledger entry updates to the new total and date, and the change is on the invoice timeline.
            To move it to another ledger, cancel it and issue a new one.
          </p>
        )}
      </PageHeader>
      <InvoiceEditor
        issued={issued}
        initial={draftFromRow(data.invoice, data.items)}
        settings={settings}
        profiles={profiles}
        clients={clients.filter((c) => c.is_active).map((c) => ({ id: c.id, name: c.name, business_name: c.business_name, phone: c.phone, email: c.email, address: c.address, logo_path: logos.get(c.id) ?? null }))}
        ledgers={ledgers.filter((l) => l.ledger_type !== "personal" && l.status === "active").map((l) => ({ id: l.id, name: l.name, contractor_id: l.contractor_id }))}
        library={library}
      />
    </div>
  );
}
