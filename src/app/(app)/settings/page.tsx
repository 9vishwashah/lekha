import Link from "next/link";
import { getMyProfile, getWorkspace } from "@/lib/server/context";
import { ProfileForm } from "./profile-form";
import { PageHeader, SectionTitle, Card } from "@/components/ui/bits";
import { WorkspaceSettingsForm, MembersPanel } from "./client";
import { NewWorkspace } from "./new-workspace";
import type { Member } from "@/lib/types";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await getWorkspace();
  const [{ data: members }, { data: invites }, profile] = await Promise.all([
    ctx.db.from("workspace_members").select("*").eq("workspace_id", ctx.workspace.id).order("created_at"),
    ctx.isAdmin
      ? ctx.db.from("invitations").select("id, email, role, expires_at, status").eq("workspace_id", ctx.workspace.id).eq("scope", "workspace").eq("status", "pending")
      : Promise.resolve({ data: [] }),
    getMyProfile(),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10">
      <PageHeader title="Settings" kicker={ctx.workspace.name} />
      <section>
        <SectionTitle className="mb-4">Workspace</SectionTitle>
        <Card>
          <WorkspaceSettingsForm workspace={ctx.workspace} canEdit={ctx.isAdmin} />
        </Card>
      </section>
      <section>
        <SectionTitle className="mb-2">Members</SectionTitle>
        <p className="mb-4 text-[15px] text-ink-2">
          Members see every ledger in this workspace. Owners and admins manage members; members add and edit entries; viewers can only look. To give a
          contractor access to just their own ledger, invite them from that ledger instead.
        </p>
        <MembersPanel
          members={(members ?? []) as Member[]}
          invites={(invites ?? []).filter((i) => new Date(i.expires_at) > new Date())}
          me={ctx.userId}
          isAdmin={ctx.isAdmin}
        />
      </section>
      <section id="profile" className="scroll-mt-24">
        <SectionTitle className="mb-4">Your profile</SectionTitle>
        <Card>
          <ProfileForm name={profile?.full_name ?? ctx.displayName ?? ""} phone={profile?.phone ?? ""} />
        </Card>
      </section>
      <section>
        <SectionTitle className="mb-4">Your account</SectionTitle>
        <Card className="flex flex-col gap-3">
          <p className="text-[15px] text-ink-2">Email, password, connected Google account and active sessions are managed by your sign-in provider.</p>
          <Link href="/settings/account" className="font-semibold underline underline-offset-4">Manage account</Link>
        </Card>
      </section>
      <section>
        <SectionTitle className="mb-4">Another business?</SectionTitle>
        <NewWorkspace />
      </section>
    </div>
  );
}
