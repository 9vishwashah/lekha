import "server-only";
import { cache } from "react";
import { anonDb } from "@/lib/supabase/server";
import { isTokenShape } from "@/lib/server/shared";

export interface InvitePreview {
  scope: "workspace" | "ledger";
  status: "pending" | "accepted" | "revoked" | "expired";
  ledger_name: string | null;
  ledger_type: string | null;
  workspace_name: string | null;
  participant_name: string | null;
  invited_by: string | null;
  role: string | null;
  permissions: Record<string, boolean>;
}

/** Public summary of an invitation (one call per request for the page, metadata and preview card). */
export const loadInvitePreview = cache(async (token: string): Promise<InvitePreview | null> => {
  if (!isTokenShape(token)) return null;
  const { data } = await anonDb().rpc("get_invitation_preview", { p_token: token });
  return (data as InvitePreview | null) ?? null;
});
