import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/server/context";
import { userDb } from "@/lib/supabase/server";
import { getLedger, peopleNames } from "@/lib/server/queries";
import { ledgerAccess } from "@/lib/server/access";
import { Badge, EmptyState, PageHeader } from "@/components/ui/bits";
import { formatDateTime } from "@/lib/domain/dates";

export const metadata = { title: "Activity" };

const ENTITY: Record<string, string> = {
  invoices: "Invoice",
  transactions: "Entry",
  transaction_tax_details: "Tax details",
  tax_settlements: "Tax payment",
  ledgers: "Ledger",
  share_links: "Share link",
  invitations: "Invitation",
  ledger_collaborators: "Collaborator",
  ledger_participants: "Person",
  shared_expenses: "Shared expense",
  settlements: "Repayment",
  import_batches: "Import",
};

const HIDDEN_KEYS = new Set(["id", "workspace_id", "ledger_id", "created_at", "created_by", "updated_by", "is_cash", "affects_party", "idempotency_key", "transaction_id"]);

function describe(action: string, changes: Record<string, unknown>) {
  if (action === "update") {
    return Object.entries(changes as Record<string, { from: unknown; to: unknown }>)
      .filter(([k]) => !HIDDEN_KEYS.has(k))
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${fmt(v?.from)} → ${fmt(v?.to)}`);
  }
  const pick = ["voucher_no", "amount", "direction", "txn_date", "description", "name", "total_amount", "status", "file_name", "display_name"];
  return pick.filter((k) => changes[k] !== undefined && changes[k] !== null).map((k) => `${k.replace(/_/g, " ")}: ${fmt(changes[k])}`);
}

const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "empty" : typeof v === "object" ? JSON.stringify(v) : String(v));

export default async function ActivityPage(props: PageProps<"/ledgers/[id]/activity">) {
  await requireUser();
  const { id } = await props.params;
  const params = (await props.searchParams) as Record<string, string>;
  const db = await userDb();
  const ledger = await getLedger(db, id);
  const access = await ledgerAccess(ledger);
  if (!access || access.kind !== "member") notFound();
  const page = Math.max(0, Number(params.page) || 0);
  const [{ data: logs }, names] = await Promise.all([
    db
      .from("audit_logs")
      .select("id, entity_type, entity_id, action, actor_user_id, actor_role, changes, created_at")
      .eq("ledger_id", id)
      .order("id", { ascending: false })
      .range(page * 100, page * 100 + 99),
    peopleNames(db, ledger.workspace_id, id),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/ledgers/${id}`} className="inline-flex h-11 items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> {ledger.name}
      </Link>
      <PageHeader title="Activity">
        <p className="mt-3 text-ink-2">Every change to this ledger, who made it and when. This history cannot be edited or deleted.</p>
      </PageHeader>
      {!logs?.length ? (
        <EmptyState title="No activity yet" body="Changes will be listed here as they happen." />
      ) : (
        <ol className="relative flex flex-col gap-3 border-l-2 border-line pl-5">
          {logs.map((log) => {
            const lines = describe(log.action, log.changes as Record<string, unknown>);
            return (
              <li key={log.id} className="relative rounded-3xl bg-surface p-4 ring-1 ring-inset ring-line/70">
                <span className="absolute -left-[29px] top-5 size-3.5 rounded-full border-2 border-canvas bg-ink" aria-hidden />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{names.get(log.actor_user_id ?? "") ?? (log.actor_role === "system" ? "System" : "Someone")}</span>
                  <Badge tone={log.actor_role === "collaborator" ? "warn" : "neutral"}>{log.actor_role}</Badge>
                  <span className="text-ink-2">
                    {log.action === "insert" ? "added" : log.action === "update" ? "changed" : "removed"} {ENTITY[log.entity_type]?.toLowerCase() ?? log.entity_type}
                  </span>
                  <span className="ml-auto text-[13px] text-ink-3">{formatDateTime(log.created_at)}</span>
                </div>
                {lines.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-[13px] text-ink-2">
                    {lines.slice(0, 8).map((l) => (
                      <li key={l} className="num break-words">
                        {l}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div className="mt-6 flex justify-between">
        {page > 0 ? <Link href={`?page=${page - 1}`} className="font-medium underline">Newer</Link> : <span />}
        {logs?.length === 100 && <Link href={`?page=${page + 1}`} className="font-medium underline">Older</Link>}
      </div>
    </div>
  );
}
