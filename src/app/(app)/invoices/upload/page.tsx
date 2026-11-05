import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { getInvoiceSettings, listPaymentProfiles } from "@/lib/server/invoices";
import { listContractors, listLedgers } from "@/lib/server/queries";
import { blankDraft } from "@/lib/invoices/editor";
import { todayISO } from "@/lib/domain/dates";
import { PageHeader } from "@/components/ui/bits";
import { UploadForm } from "./client";

export const metadata = { title: "Upload invoice" };

export default async function UploadInvoice() {
  const ctx = await getWorkspace();
  const [settings, profiles, clients, ledgers] = await Promise.all([
    getInvoiceSettings(ctx.db, ctx.workspace.id, ctx.workspace.name),
    listPaymentProfiles(ctx.db, ctx.workspace.id),
    listContractors(ctx.db, ctx.workspace.id),
    listLedgers(ctx.db, ctx.workspace.id),
  ]);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <Link href="/invoices/new" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Back
      </Link>
      <PageHeader title="Upload invoice">
        <p className="mt-2 text-ink-2">Your document stays exactly as you made it. Add the few details Lekha needs to track payment.</p>
      </PageHeader>
      <UploadForm
        initial={blankDraft("custom", settings, profiles, todayISO())}
        profiles={profiles}
        clients={clients.filter((c) => c.is_active).map((c) => ({ id: c.id, name: c.name, business_name: c.business_name, phone: c.phone, email: c.email, address: c.address }))}
        ledgers={ledgers.filter((l) => l.ledger_type !== "personal" && l.status === "active").map((l) => ({ id: l.id, name: l.name, contractor_id: l.contractor_id }))}
      />
    </div>
  );
}
