import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { unstable_cache } from "next/cache";
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

/**
 * The first database call after sign-in failed. These are almost always configuration problems
 * (Supabase not trusting Clerk, a missing session claim, migrations not applied), so the app shows
 * a page that says which one instead of a bare "server error". No secrets are included.
 */
export type ServiceProblemKind = "trust" | "role" | "schema" | "expired" | "network" | "unknown";

export class ServiceError extends Error {
  kind: ServiceProblemKind;
  code: string;
  constructor(error: { code?: string; message?: string }) {
    const msg = error.message ?? "";
    const code = error.code ?? "";
    const kind: ServiceProblemKind =
      (code === "PGRST301" || code === "PGRST302") && /suitable key|decode|issuer|kid/i.test(msg)
        ? "trust"
        : code === "PGRST303" || /jwt expired/i.test(msg)
          ? "expired"
          : code === "42501" || /permission denied/i.test(msg)
            ? "role"
            : ["42P01", "42703", "42883", "PGRST200", "PGRST202", "PGRST204", "PGRST205"].includes(code) || /does not exist|schema cache/i.test(msg)
              ? "schema"
              : /fetch failed|network|ECONN|ETIMEDOUT/i.test(msg)
                ? "network"
                : "unknown";
    super(`Could not load your workspaces (${kind}${code ? ` ${code}` : ""})`);
    this.kind = kind;
    this.code = code;
  }
}

/** Memberships, or the configuration problem that stopped them loading. */
export async function loadMemberships(): Promise<{ memberships: Membership[]; problem: null } | { memberships: null; problem: ServiceError }> {
  try {
    return { memberships: await getMemberships(), problem: null };
  } catch (e) {
    if (e instanceof ServiceError) return { memberships: null, problem: e };
    throw e;
  }
}

export interface Membership {
  id: string;
  role: Role;
  display_name: string | null;
  workspace: Workspace;
}

/** Expired by every action that changes who belongs to a workspace, a role, or workspace settings. */
export const MEMBERSHIPS_TAG = "memberships";

export const getMemberships = cache(async (): Promise<Membership[]> => {
  const userId = await requireUser();
  const db = await userDb();
  const load = async () => {
    const { data, error } = await db
      .from("workspace_members")
      .select(
        "id, role, display_name, workspace:workspaces(id, name, owner_user_id, currency, timezone, fy_start_month, default_gst_rate, default_tds_rate, default_tds_base, default_gst_mode)",
      )
      .eq("user_id", userId)
      .order("created_at");
    if (error) {
      console.error("[db] workspace_members", error.code, error.message, error.details);
      throw new ServiceError(error);
    }
    return (data ?? []) as unknown as Membership[];
  };
  // Every screen starts here, and the list rarely changes, so it is kept per user for a few minutes
  // and each screen goes straight to its own queries. Access itself is still enforced by RLS on every
  // query, so a stale entry can at most show a workspace name, never its data. Errors are not cached.
  return unstable_cache(load, ["memberships", userId], { tags: [MEMBERSHIPS_TAG], revalidate: 300 })();
});

export interface MyProfile {
  full_name: string;
  phone: string | null;
}

/** The signed-in user's own profile (name and private mobile), or null before it is set. */
export const getMyProfile = cache(async (): Promise<MyProfile | null> => {
  await requireUser();
  const db = await userDb();
  const { data } = await db.from("user_profiles").select("full_name, phone").maybeSingle();
  return (data as MyProfile | null) ?? null;
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
