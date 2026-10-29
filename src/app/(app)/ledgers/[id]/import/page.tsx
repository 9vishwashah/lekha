import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/server/context";
import { userDb } from "@/lib/supabase/server";
import { getLedger } from "@/lib/server/queries";
import { ledgerAccess } from "@/lib/server/access";
import { PageHeader } from "@/components/ui/bits";
import { ImportWizard } from "@/components/app/import-wizard";
import { formatDateTime } from "@/lib/domain/dates";

export const metadata = { title: "Import from Excel" };

export default async function ImportPage(props: PageProps<"/ledgers/[id]/import">) {
  await requireUser();
  const { id } = await props.params;
  const db = await userDb();
  const ledger = await getLedger(db, id);
  const access = await ledgerAccess(ledger);
  if (!access?.canManage || ledger.ledger_type === "personal") notFound();
  const { data: batches } = await db
    .from("import_batches")
    .select("id, file_name, sheet_name, imported_count, skipped_count, created_at")
    .eq("ledger_id", id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-6xl">
      <Link href={`/ledgers/${id}`} className="inline-flex h-11 items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> {ledger.name}
      </Link>
      <PageHeader title="Import from Excel">
        <p className="mt-3 max-w-2xl text-ink-2">
          Upload an .xlsx sheet with columns like SR. NO., DATE, PAYEE, CREDIT, DEBIT{ledger.ledger_type === "taxation" ? ", BILL AMT, GST, TDS, AFTER TDS" : ""}.
          You will see every row before anything is saved. Totals and running balance cells are never imported; balances are recalculated.
        </p>
      </PageHeader>
      <ImportWizard ledgerId={id} ledgerType={ledger.ledger_type as "basic" | "taxation"} />
      {batches && batches.length > 0 && (
        <section className="mt-12">
          <h2 className="display mb-3 text-2xl font-bold">Earlier imports</h2>
          <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[15px]">
                <span className="min-w-0 truncate font-medium">
                  {b.file_name} · {b.sheet_name}
                </span>
                <span className="text-ink-2">
                  {b.imported_count} imported · {b.skipped_count} skipped · {formatDateTime(b.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
