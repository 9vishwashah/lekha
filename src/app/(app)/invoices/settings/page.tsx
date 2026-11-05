import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { getInvoiceSettings, listLibrary, listPaymentProfiles } from "@/lib/server/invoices";
import { PageHeader } from "@/components/ui/bits";
import { InvoiceSettingsScreen } from "./client";

export const metadata = { title: "Invoice settings" };

export default async function InvoiceSettingsPage(props: PageProps<"/invoices/settings">) {
  const ctx = await getWorkspace();
  const params = (await props.searchParams) as Record<string, string>;
  const [settings, profiles, library] = await Promise.all([
    getInvoiceSettings(ctx.db, ctx.workspace.id, ctx.workspace.name),
    ctx.canWrite ? listPaymentProfiles(ctx.db, ctx.workspace.id) : Promise.resolve([]),
    listLibrary(ctx.db, ctx.workspace.id),
  ]);
  return (
    <div className="flex flex-col gap-5">
      <Link href="/invoices" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Invoices
      </Link>
      <PageHeader title="Invoice settings">
        <p className="mt-2 text-ink-2">{ctx.isAdmin ? "Your business, your look, and how clients pay you." : "Only owners and admins can change these."}</p>
      </PageHeader>
      <InvoiceSettingsScreen settings={settings} profiles={profiles} library={library} canEdit={ctx.isAdmin} initialTab={params.tab} fyStart={ctx.workspace.fy_start_month} />
    </div>
  );
}
