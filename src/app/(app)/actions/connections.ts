"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { requireUser } from "@/lib/server/context";
import { type ActionResult, fail } from "@/lib/server/errors";

const uuid = z.string().uuid();

const refreshClient = (contractorId: string) => {
  revalidatePath(`/contractors/${contractorId}`);
  revalidatePath("/contractors");
};

/** Sends (or re-sends) a connect request to the client's email. Nothing links until they accept. */
export async function requestConnection(contractorId: string, email: string): Promise<ActionResult> {
  await requireUser();
  const parsed = z.string().trim().max(200).safeParse(email);
  if (!parsed.success) return { ok: false, error: "Enter a valid email address", fieldErrors: { email: "Enter a valid email address" } };
  const db = await userDb();
  const { error } = await db.rpc("request_client_connection", { p_contractor: uuid.parse(contractorId), p_email: parsed.data });
  if (error) return fail(error);
  refreshClient(contractorId);
  return { ok: true, message: "Request sent" };
}

export async function cancelConnection(contractorId: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("cancel_client_connection", { p_contractor: uuid.parse(contractorId) });
  if (error) return fail(error);
  refreshClient(contractorId);
  return { ok: true, message: "Request withdrawn" };
}

export async function disconnectClient(contractorId: string): Promise<ActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.rpc("disconnect_client", { p_contractor: uuid.parse(contractorId) });
  if (error) return fail(error);
  refreshClient(contractorId);
  return { ok: true, message: "Disconnected. Their entries stay as they are." };
}

/** The recipient's answer. Accepting opens the shared accounts they are part of. */
export async function respondConnection(requestId: string, accept: boolean): Promise<ActionResult<{ sharedAccounts: number }>> {
  await requireUser();
  const db = await userDb();
  const { data, error } = await db.rpc("respond_client_connection", { p_id: uuid.parse(requestId), p_accept: accept });
  if (error) return fail(error);
  revalidatePath("/", "layout");
  const shared = (data as { shared_accounts?: number } | null)?.shared_accounts ?? 0;
  return {
    ok: true,
    data: { sharedAccounts: shared },
    message: !accept ? "Request declined" : shared ? `Connected. ${shared === 1 ? "1 shared account" : `${shared} shared accounts`} added to Shared with me.` : "Connected",
  };
}
