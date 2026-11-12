"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userDb } from "@/lib/supabase/server";
import { requireUser } from "@/lib/server/context";

/** Unread count for the bell. */
export async function unreadNotifications(): Promise<number> {
  const userId = await requireUser();
  const db = await userDb();
  const { count } = await db.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null);
  return count ?? 0;
}

/** Marks some notifications (or all, with no ids) as read. */
export async function markNotificationsRead(ids?: number[]): Promise<void> {
  await requireUser();
  const parsed = z.array(z.number().int().positive()).max(500).optional().safeParse(ids);
  if (!parsed.success) return;
  const db = await userDb();
  await db.rpc("mark_notifications_read", { p_ids: parsed.data ?? null });
  revalidatePath("/notifications");
  revalidatePath("/", "layout");
}
