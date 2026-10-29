"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { WORKSPACE_COOKIE, getMemberships, getMyProfile, getWorkspace, requireUser } from "@/lib/server/context";
import { type ActionResult, fail } from "@/lib/server/errors";
import { newToken } from "@/lib/server/tokens";
import { appUrl } from "@/lib/env";
import { fullName, mobile } from "@/lib/validation/profile";

const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 };

export async function switchWorkspace(workspaceId: string) {
  const memberships = await getMemberships();
  // Only a workspace the user already belongs to can be selected.
  if (!memberships.some((m) => m.workspace.id === workspaceId)) return;
  (await cookies()).set(WORKSPACE_COOKIE, workspaceId, cookieOptions);
  revalidatePath("/", "layout");
}

async function viewerIdentity() {
  const [user, profile] = await Promise.all([currentUser(), getMyProfile()]);
  return {
    name:
      profile?.full_name ||
      user?.fullName ||
      user?.firstName ||
      user?.username ||
      user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
      "You",
    email: user?.primaryEmailAddress?.emailAddress ?? null,
  };
}

export async function createWorkspace(_: unknown, form: FormData): Promise<ActionResult> {
  await requireUser();
  const parsed = z
    .object({
      full_name: fullName,
      phone: mobile,
      name: z.string().trim().min(1, "Give your workspace a name").max(120),
    })
    .safeParse({ full_name: form.get("full_name") ?? "", phone: form.get("phone") ?? "", name: form.get("name") ?? "" });
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields",
      fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
    };
  }
  const me = await viewerIdentity();
  const db = await userDb();
  const saved = await db.rpc("save_my_profile", { p_full_name: parsed.data.full_name, p_phone: parsed.data.phone });
  if (saved.error) return fail(saved.error);
  const { data, error } = await db.rpc("create_workspace", { p_name: parsed.data.name, p_display_name: parsed.data.full_name, p_email: me.email });
  if (error) return fail(error);
  (await cookies()).set(WORKSPACE_COOKIE, data as string, cookieOptions);
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function saveProfile(_: unknown, form: FormData): Promise<ActionResult> {
  await requireUser();
  const parsed = z
    .object({ full_name: fullName, phone: mobile })
    .safeParse({ full_name: form.get("full_name") ?? "", phone: form.get("phone") ?? "" });
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields",
      fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
    };
  }
  const db = await userDb();
  const { error } = await db.rpc("save_my_profile", { p_full_name: parsed.data.full_name, p_phone: parsed.data.phone });
  if (error) return fail(error);
  revalidatePath("/", "layout");
  return { ok: true, message: "Profile saved" };
}

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fy_start_month: z.coerce.number().int().min(1).max(12),
  default_gst_rate: z.string().regex(/^\d{1,2}(\.\d{1,3})?$/, "Enter a rate like 18"),
  default_tds_rate: z.string().regex(/^\d{1,2}(\.\d{1,3})?$/, "Enter a rate like 1"),
  default_tds_base: z.enum(["taxable", "gross"]),
  default_gst_mode: z.enum(["intra", "inter"]),
});

export async function updateWorkspace(_: unknown, form: FormData): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const parsed = settingsSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields", fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
  }
  const { error } = await ctx.db.rpc("update_workspace", { p_workspace: ctx.workspace.id, p: parsed.data });
  if (error) return fail(error);
  revalidatePath("/", "layout");
  return { ok: true, message: "Settings saved" };
}

export async function inviteMember(_: unknown, form: FormData): Promise<ActionResult<{ url: string }>> {
  const ctx = await getWorkspace();
  const role = z.enum(["admin", "member", "viewer"]).safeParse(form.get("role"));
  if (!role.success) return { ok: false, error: "Choose a role" };
  const email = z.string().trim().email().max(200).optional().or(z.literal("")).safeParse(form.get("email") ?? "");
  if (!email.success) return { ok: false, error: "Enter a valid email or leave it empty", fieldErrors: { email: "Enter a valid email" } };
  const token = newToken();
  const { error } = await ctx.db.rpc("create_invitation", {
    p_token: token,
    p: { scope: "workspace", workspace_id: ctx.workspace.id, role: role.data, email: email.data || null },
  });
  if (error) return fail(error);
  revalidatePath("/settings");
  return { ok: true, data: { url: `${appUrl()}/invite/${token}` }, message: "Invitation link created" };
}

export async function setMemberRole(memberId: string, role: string): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const { error } = await ctx.db.rpc("set_member_role", { p_member: memberId, p_role: role });
  if (error) return fail(error);
  revalidatePath("/settings");
  return { ok: true, message: "Role updated" };
}

export async function removeMember(memberId: string): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const { error } = await ctx.db.rpc("remove_member", { p_member: memberId });
  if (error) return fail(error);
  revalidatePath("/settings");
  return { ok: true, message: "Member removed" };
}

export async function revokeInvitation(id: string): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const { error } = await ctx.db.rpc("revoke_invitation", { p_id: id });
  if (error) return fail(error);
  revalidatePath("/settings");
  return { ok: true, message: "Invitation revoked" };
}

export async function acceptInvitation(token: string): Promise<ActionResult<{ href: string }>> {
  await requireUser();
  const me = await viewerIdentity();
  const db = await userDb();
  const { data, error } = await db.rpc("accept_invitation", { p_token: token, p_display_name: me.name, p_email: me.email });
  if (error) return fail(error);
  const result = data as { scope: string; workspace_id: string; ledger_id: string | null };
  if (result.scope === "workspace") {
    (await cookies()).set(WORKSPACE_COOKIE, result.workspace_id, cookieOptions);
  }
  revalidatePath("/", "layout");
  return { ok: true, data: { href: result.ledger_id ? `/ledgers/${result.ledger_id}` : "/dashboard" } };
}
