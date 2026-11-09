import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/server/context";
import { userDb } from "@/lib/supabase/server";
import { getCollaborators, getLedger, getPersonalLedger, listContractors } from "@/lib/server/queries";
import { LedgerMeaningForm } from "@/components/app/ledger-meaning";
import { Card, SectionTitle } from "@/components/ui/bits";
import { ledgerAccess } from "@/lib/server/access";
import { PageHeader } from "@/components/ui/bits";
import { LedgerSettings } from "@/components/app/ledger-settings";
import { loadPeople } from "@/lib/server/profiles";

export const metadata = { title: "Ledger settings" };

export default async function LedgerSettingsPage(props: PageProps<"/ledgers/[id]/settings">) {
  await requireUser();
  const { id } = await props.params;
  const db = await userDb();
  const ledger = await getLedger(db, id);
  const access = await ledgerAccess(ledger);
  if (!access?.canManage) notFound();

  const [collaborators, invitations, contractors, personal] = await Promise.all([
    getCollaborators(db, id),
    db
      .from("invitations")
      .select("id, email, participant_id, can_create, can_edit_own, can_edit_all, can_view_tax, status, expires_at, created_at")
      .eq("ledger_id", id)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    listContractors(db, ledger.workspace_id),
    ledger.ledger_type === "personal" ? getPersonalLedger(db, id) : Promise.resolve(null),
  ]);

  const people = await loadPeople(db, [...collaborators.map((c) => c.user_id), ...(personal?.participants ?? []).map((p) => p.user_id)]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/ledgers/${id}`} className="inline-flex h-11 items-center gap-2 text-sm font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> {ledger.name}
      </Link>
      <PageHeader title="Ledger settings" />
      {ledger.perspective === "cashbook" && (
        <section className="mb-8">
          <SectionTitle className="mb-4">Accounting head</SectionTitle>
          <Card>
            <LedgerMeaningForm ledger={ledger} />
          </Card>
        </section>
      )}
      <LedgerSettings
        ledger={ledger}
        contractors={contractors.filter((c) => c.is_active || c.id === ledger.contractor_id).map((c) => ({ id: c.id, name: c.name, kind: c.kind, phone: c.phone }))}
        collaborators={collaborators}
        invitations={(invitations.data ?? []).filter((i) => new Date(i.expires_at) > new Date())}
        participants={personal?.participants ?? []}
        people={Object.fromEntries([...people].map(([uid, p]) => [uid, { username: p.username, photo: p.photo }]))}
      />
    </div>
  );
}
