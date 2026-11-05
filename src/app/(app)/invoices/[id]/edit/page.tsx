import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { clientLogos, getInvoice, getInvoiceSettings, listLibrary, listPaymentProfiles } from "@/lib/server/invoices";
import { isUuid, listContractors, listLedgers } from "@/lib/server/queries";
import { draftFromRow } from "@/lib/invoices/editor";
import { PageHeader } from "@/components/ui/bits";
import { InvoiceEditor } from "@/components/app/invoice/invoice-editor";

export const metadata = { title: "Edit draft" };

export default async function EditInvoice(props: PageProps<"/invoices/[id]/edit">) {
  const ctx = await getWorkspace();
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const data = await getInvoice(ctx.db, id);
  if (!data) notFound();
  if (data.invoice.status !== "draft" || !ctx.canWrite) redirect(`/invoices/${id}`);
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
        <ArrowLeft className="size-4" /> Draft details
      </Link>
      <PageHeader title="Edit draft" />
      <InvoiceEditor
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
