"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { getWorkspace, requireUser } from "@/lib/server/context";
import { type ActionResult, fail } from "@/lib/server/errors";
import { username } from "@/lib/validation/profile";

const uuid = z.string().uuid();
const permissions = z
  .object({
    can_create: z.boolean(),
    can_edit_own: z.boolean(),
    can_edit_all: z.boolean(),
    can_attach: z.boolean(),
    can_view_tax: z.boolean(),
  })
  .partial();

/** Adds a Lekha user to a ledger or shared account by their exact @username. */
export async function addToLedgerByUsername(ledgerId: string, name: string, perms: z.input<typeof permissions> = {}): Promise<ActionResult> {
  await requireUser();
  const handle = username.safeParse(name);
  if (!handle.success) return { ok: false, error: handle.error.issues[0].message };
  const db = await userDb();
  const { data, error } = await db.rpc("add_to_ledger_by_username", { p_ledger: uuid.parse(ledgerId), p_username: handle.data, p: permissions.parse(perms) });
  if (error) return fail(error);
  revalidatePath(`/ledgers/${ledgerId}`, "layout");
  revalidatePath("/contractors");
  return { ok: true, message: `${(data as { full_name: string }).full_name} added. They see it in Shared with me.` };
}

/** Links a client record to that person's Lekha account; their shared accounts open up for them. */
export async function linkClient(contractorId: string, name: string): Promise<ActionResult> {
  await requireUser();
  const handle = username.safeParse(name);
  if (!handle.success) return { ok: false, error: handle.error.issues[0].message };
  const db = await userDb();
  const { data, error } = await db.rpc("link_client_by_username", { p_contractor: uuid.parse(contractorId), p_username: handle.data });
  if (error) return fail(error);
  revalidatePath(`/contractors/${contractorId}`);
  revalidatePath("/contractors");
  return { ok: true, message: `Linked to @${(data as { username: string }).username}` };
}

/**
 * New client straight from someone's @username: the card is created with their name and linked to
 * their account in one go, so balances with them show for both of you from the start.
 */
export async function addClientByUsername(name: string, kind: "business" | "personal"): Promise<ActionResult<{ id: string }>> {
  const ctx = await getWorkspace();
  const handle = username.safeParse(name);
  if (!handle.success) return { ok: false, error: handle.error.issues[0].message };
  const { data: found } = await ctx.db.rpc("find_by_username", { p_username: handle.data });
  const person = found as { username: string; full_name: string } | null;
  if (!person) return { ok: false, error: `No one on Lekha is @${handle.data}` };
  const { data: card, error } = await ctx.db
    .from("contractors")
    .insert({ workspace_id: ctx.workspace.id, name: person.full_name.slice(0, 160), kind: kind === "business" ? "business" : "personal", created_by: ctx.userId })
    .select("id")
    .single();
  if (error) return fail(error);
  const linked = await ctx.db.rpc("link_client_by_username", { p_contractor: card.id, p_username: person.username });
  if (linked.error) {
    await ctx.db.from("contractors").delete().eq("id", card.id);
    return fail(linked.error);
  }
  revalidatePath("/contractors");
  return { ok: true, data: { id: card.id as string }, message: `${person.full_name} added and linked` };
}

/** Which of these phone numbers belong to someone on Lekha (last 10 digits; yes/no only). */
export async function phonesOnLekha(phones: string[]): Promise<string[]> {
  await requireUser();
  const clean = z.array(z.string().max(30)).max(100).safeParse(phones);
  if (!clean.success) return [];
  const db = await userDb();
  const { data } = await db.rpc("phones_on_lekha", { p_phones: clean.data });
  return (data as string[] | null) ?? [];
}

export async function unlinkClient(contractorId: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("disconnect_client", { p_contractor: uuid.parse(contractorId) });
  if (error) return fail(error);
  revalidatePath(`/contractors/${contractorId}`);
  revalidatePath("/contractors");
  return { ok: true, message: "Unlinked. Their entries stay as they are." };
}
