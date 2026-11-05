import Link from "next/link";
import { ArrowLeft, ArrowRight, FileUp } from "lucide-react";
import { getWorkspace } from "@/lib/server/context";
import { INVOICE_TYPES } from "@/lib/domain/invoice";
import { PageHeader } from "@/components/ui/bits";

export const metadata = { title: "Create invoice" };

const TILE: Record<string, string> = {
  service: "bg-mustard text-ink",
  project: "bg-lavender text-ink",
  product: "bg-sky text-ink",
  gst: "bg-tea text-seashell",
  proforma: "bg-pink text-ink",
  custom: "bg-surface text-ink ring-1 ring-inset ring-line",
};

/** Two ways in: make it here, or bring the invoice you already have. */
export default async function NewInvoice() {
  await getWorkspace();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <Link href="/invoices" className="inline-flex h-11 w-fit items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Invoices
      </Link>
      <PageHeader title="Create invoice" />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">Create using Lekha</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {INVOICE_TYPES.map((t) => (
            <Link key={t.value} href={`/invoices/new/create?type=${t.value}`} className={`flex min-h-40 flex-col justify-between rounded-[var(--radius-card)] p-5 transition-transform active:scale-[0.99] ${TILE[t.value]}`}>
              <ArrowRight className="size-5 self-end" />
              <span>
                <span className="display block text-xl font-bold">{t.label}</span>
                <span className="mt-1 block text-[14px] opacity-80">{t.hint}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">Already have an invoice?</h2>
        <Link href="/invoices/upload" className="flex items-center gap-4 rounded-[var(--radius-card)] bg-ink p-5 text-seashell sm:p-6">
          <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-white/10">
            <FileUp className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="display block text-xl font-bold">Upload existing invoice</span>
            <span className="block text-[14px] opacity-75">PDF, Word or image. Your document stays exactly as you made it; Lekha tracks its payments and gives you a link to share.</span>
          </span>
          <ArrowRight className="size-5 shrink-0" />
        </Link>
      </section>
    </div>
  );
}
