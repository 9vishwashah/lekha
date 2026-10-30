import "server-only";
import type { Db } from "@/lib/supabase/server";
import { avatarUrl } from "@/lib/avatar";

export interface PublicPerson {
  username: string | null;
  fullName: string;
  photo: string | null;
}

/** Username, name and photo for a set of Lekha accounts (never their mobile). Missing ids are skipped. */
export async function loadPeople(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, PublicPerson>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const { data } = await db.rpc("people_profiles", { p_ids: unique });
  const rows = (data ?? []) as { user_id: string; username: string | null; full_name: string; avatar_path: string | null }[];
  return new Map(rows.map((r) => [r.user_id, { username: r.username, fullName: r.full_name, photo: avatarUrl(r.avatar_path) }]));
}
