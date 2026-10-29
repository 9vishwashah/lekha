import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { userDb } from "@/lib/supabase/server";
import type { Role, Workspace } from "@/lib/types";

export const WORKSPACE_COOKIE = "lekha_ws";

/** Signed-in user or a redirect to sign in. */
export const requireUser = cache(async () => {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  return userId;
});

export interface Membership {
  id: string;
  role: Role;
  display_name: string | null;
  workspace: Workspace;
}

export const getMemberships = cache(async (): Promise<Membership[]> => {
  const userId = await requireUser();
  const db = await userDb();
  const { data, error } = await db
    .from("workspace_members")
    .select(
      "id, role, display_name, workspace:workspaces(id, name, owner_user_id, currency, timezone, fy_start_month, default_gst_rate, default_tds_rate, default_tds_base, default_gst_mode)",
    )
    .eq("user_id", userId)
    .order("created_at");
  if (error) {
    console.error("[db] workspace_members", error.code, error.message, error.details);
    // PGRST301/302: Supabase could not verify the Clerk session token. This is a setup problem,
    // not a data problem, so say so (production users still only see the generic error page).
    if ((error.code === "PGRST301" || error.code === "PGRST302") && /suitable key|decode/i.test(error.message)) {
      throw new Error(
        "Supabase could not verify your sign-in. Add Clerk under Supabase → Authentication → Third-Party Auth, and make sure Clerk session tokens include role = authenticated.",
      );
    }
    throw new Error("Could not load your workspaces");
  }
  return (data ?? []) as unknown as Membership[];
});

/** Ledgers other people shared with this user (as a collaborator, outside their own workspaces). */
export const getCollaborations = cache(async () => {
  const userId = await requireUser();
  const db = await userDb();
  const { data } = await db
    .from("ledger_collaborators")
    .select("id, ledger_id, participant_id, can_create, can_edit_own, can_edit_all, can_view_tax, can_attach, ledger:ledgers(id, name, ledger_type, color, last_activity_at)")
    .eq("user_id", userId)
    .eq("status", "active");
  return (data ?? []) as unknown as {
    id: string;
    ledger_id: string;
    participant_id: string | null;
    can_create: boolean;
    can_edit_own: boolean;
    can_edit_all: boolean;
    can_view_tax: boolean;
    can_attach: boolean;
    ledger: { id: string; name: string; ledger_type: string; color: string; last_activity_at: string } | null;
  }[];
});

/**
 * The active workspace for this request. The cookie only selects among workspaces the user is a
 * member of (checked against RLS-filtered memberships), so it can never grant access.
 */
export const getWorkspace = cache(async () => {
  const userId = await requireUser();
  const memberships = await getMemberships();
  if (memberships.length === 0) {
    const shared = await getCollaborations();
    redirect(shared.length ? "/shared" : "/onboarding");
  }
  const chosen = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const current = memberships.find((m) => m.workspace.id === chosen) ?? memberships[0];
  const db = await userDb();
  return {
    userId,
    db,
    workspace: current.workspace,
    role: current.role,
    memberships,
    displayName: current.display_name,
    canWrite: current.role !== "viewer",
    isAdmin: current.role === "owner" || current.role === "admin",
  };
});

export type WorkspaceContext = Awaited<ReturnType<typeof getWorkspace>>;
