"use server";
import { cookies } from "next/headers";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { MEMBERSHIPS_TAG, WORKSPACE_COOKIE, getCollaborations, getMemberships, getMyProfile, getWorkspace, requireUser } from "@/lib/server/context";
import { type ActionResult, fail, friendlyMessage } from "@/lib/server/errors";
import { newToken } from "@/lib/server/tokens";
import { inviteReturnPath } from "@/lib/server/shared";
import { appUrl } from "@/lib/env";
import { fullName, mobile, username } from "@/lib/validation/profile";
import { avatarUrl } from "@/lib/avatar";

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

const fieldErrors = (issues: z.core.$ZodIssue[]) => Object.fromEntries(issues.map((i) => [String(i.path[0]), i.message]));

/**
 * First-time setup and "Another business?". Setup asks for your name, @username and mobile (saved
 * once to your profile) and a workspace name. People who came from an invitation, or who only use
 * what others share with them, may skip the workspace.
 */
export async function createWorkspace(_: unknown, form: FormData): Promise<ActionResult> {
  await requireUser();
  const next = inviteReturnPath(form.get("next"));
  const withProfile = form.has("full_name");
  const [memberships, shared] = await Promise.all([getMemberships(), getCollaborations()]);
  const workspaceOptional = Boolean(next) || memberships.length > 0 || shared.length > 0;
  const parsed = z
    .object({
      full_name: withProfile ? fullName : z.undefined(),
      phone: withProfile ? mobile : z.undefined(),
      username: withProfile ? username : z.undefined(),
      name: workspaceOptional
        ? z.string().trim().max(120, "Keep it under 120 characters")
        : z.string().trim().min(1, "Give your workspace a name").max(120, "Keep it under 120 characters"),
    })
    .safeParse({
      full_name: withProfile ? (form.get("full_name") ?? "") : undefined,
      phone: withProfile ? (form.get("phone") ?? "") : undefined,
      username: withProfile ? (form.get("username") ?? "") : undefined,
      name: form.get("name") ?? "",
    });
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields", fieldErrors: fieldErrors(parsed.error.issues) };
  const db = await userDb();
  if (parsed.data.full_name && parsed.data.phone && parsed.data.username) {
    const saved = await db.rpc("save_my_profile", { p_full_name: parsed.data.full_name, p_phone: parsed.data.phone });
    if (saved.error) return fail(saved.error);
    const handle = await db.rpc("set_my_username", { p_username: parsed.data.username });
    if (handle.error) return { ok: false, error: friendlyMessage(handle.error), fieldErrors: { username: friendlyMessage(handle.error) } };
  }
  if (parsed.data.name) {
    const me = await viewerIdentity();
    const { data, error } = await db.rpc("create_workspace", { p_name: parsed.data.name, p_display_name: parsed.data.full_name ?? me.name, p_email: me.email });
    if (error) return fail(error);
    (await cookies()).set(WORKSPACE_COOKIE, data as string, cookieOptions);
  }
  updateTag(MEMBERSHIPS_TAG);
  revalidatePath("/", "layout");
  redirect(next ?? (parsed.data.name || memberships.length ? "/dashboard" : "/shared"));
}

/** Live check while typing a username. */
export async function checkUsername(name: string): Promise<boolean> {
  await requireUser();
  const parsed = username.safeParse(name);
  if (!parsed.success) return false;
  const db = await userDb();
  const { data } = await db.rpc("username_available", { p_username: parsed.data });
  return data === true;
}

export async function saveProfile(_: unknown, form: FormData): Promise<ActionResult> {
  await requireUser();
  const parsed = z
    .object({ full_name: fullName, phone: mobile, username })
    .safeParse({ full_name: form.get("full_name") ?? "", phone: form.get("phone") ?? "", username: form.get("username") ?? "" });
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields", fieldErrors: fieldErrors(parsed.error.issues) };
  const db = await userDb();
  const { error } = await db.rpc("save_my_profile", { p_full_name: parsed.data.full_name, p_phone: parsed.data.phone });
  if (error) return fail(error);
  const handle = await db.rpc("set_my_username", { p_username: parsed.data.username });
  if (handle.error) return { ok: false, error: friendlyMessage(handle.error), fieldErrors: { username: friendlyMessage(handle.error) } };
  updateTag(MEMBERSHIPS_TAG);
  revalidatePath("/", "layout");
  return { ok: true, message: "Profile saved" };
}

const PHOTO_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

/**
 * Saves a profile photo. The browser has already cropped it to a small square; this stores it in
 * the person's own folder of the public "avatars" bucket and removes the previous one.
 */
export async function uploadAvatar(form: FormData): Promise<ActionResult<{ url: string }>> {
  const userId = await requireUser();
  const file = form.get("photo");
  if (!(file instanceof File) || !PHOTO_TYPES.has(file.type)) return { ok: false, error: "Choose a JPG, PNG or WebP photo" };
  if (file.size > 1024 * 1024) return { ok: false, error: "That photo is too large. Try another." };
  const db = await userDb();
  const before = await getMyProfile();
  const path = `${userId}/${Date.now().toString(36)}.${file.type.split("/")[1]}`;
  const up = await db.storage.from("avatars").upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
  if (up.error) return { ok: false, error: "The photo could not be uploaded. Try again." };
  const { error } = await db.rpc("set_my_avatar", { p_path: path });
  if (error) return fail(error);
  if (before?.avatar_path) await db.storage.from("avatars").remove([before.avatar_path]);
  revalidatePath("/", "layout");
  return { ok: true, data: { url: avatarUrl(path)! }, message: "Photo updated" };
}

export async function removeAvatar(): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const before = await getMyProfile();
  const { error } = await db.rpc("set_my_avatar", { p_path: null });
  if (error) return fail(error);
  if (before?.avatar_path) await db.storage.from("avatars").remove([before.avatar_path]);
  revalidatePath("/", "layout");
  return { ok: true, message: "Photo removed" };
}

/** Exact @username lookup before adding someone (name and photo only). */
export async function findPerson(name: string): Promise<{ username: string; fullName: string; photo: string | null } | null> {
  await requireUser();
  const parsed = username.safeParse(name);
  if (!parsed.success) return null;
  const db = await userDb();
  const { data } = await db.rpc("find_by_username", { p_username: parsed.data });
  const row = data as { username: string; full_name: string; avatar_path: string | null } | null;
  return row ? { username: row.username, fullName: row.full_name, photo: avatarUrl(row.avatar_path) } : null;
}

export async function addMemberByUsername(name: string, role: string): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const r = z.enum(["admin", "member", "viewer"]).safeParse(role);
  if (!r.success) return { ok: false, error: "Choose a role" };
  const { data, error } = await ctx.db.rpc("add_member_by_username", { p_workspace: ctx.workspace.id, p_username: name, p_role: r.data });
  if (error) return fail(error);
  updateTag(MEMBERSHIPS_TAG);
  revalidatePath("/settings");
  return { ok: true, message: `${(data as { full_name: string }).full_name} added` };
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
  updateTag(MEMBERSHIPS_TAG);
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
  updateTag(MEMBERSHIPS_TAG);
  revalidatePath("/settings");
  return { ok: true, message: "Role updated" };
}

export async function removeMember(memberId: string): Promise<ActionResult> {
  const ctx = await getWorkspace();
  const { error } = await ctx.db.rpc("remove_member", { p_member: memberId });
  if (error) return fail(error);
  updateTag(MEMBERSHIPS_TAG);
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
  updateTag(MEMBERSHIPS_TAG);
  revalidatePath("/", "layout");
  return { ok: true, data: { href: result.ledger_id ? `/ledgers/${result.ledger_id}` : "/dashboard" } };
}
