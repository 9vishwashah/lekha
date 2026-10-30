"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { requireUser } from "@/lib/server/context";
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

export async function unlinkClient(contractorId: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("disconnect_client", { p_contractor: uuid.parse(contractorId) });
  if (error) return fail(error);
  revalidatePath(`/contractors/${contractorId}`);
  revalidatePath("/contractors");
  return { ok: true, message: "Unlinked. Their entries stay as they are." };
}
