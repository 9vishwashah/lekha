import "server-only";
import { getCollaborations, getMemberships } from "./context";

export interface LedgerAccess {
  kind: "member" | "collaborator";
  role: "owner" | "admin" | "member" | "viewer" | "collaborator";
  canCreate: boolean;
  canEditOwn: boolean;
  canEditAll: boolean;
  canViewTax: boolean;
  canManage: boolean; // sharing, settings, archive
  participantId: string | null;
}

/**
 * What the current user may do in a ledger, for showing the right controls. The database
 * enforces the same rules independently; this never grants anything by itself.
 */
export async function ledgerAccess(ledger: { id: string; workspace_id: string }): Promise<LedgerAccess | null> {
  const memberships = await getMemberships();
  const m = memberships.find((x) => x.workspace.id === ledger.workspace_id);
  if (m) {
    const write = m.role !== "viewer";
    return {
      kind: "member",
      role: m.role,
      canCreate: write,
      canEditOwn: write,
      canEditAll: write,
      canViewTax: true,
      canManage: write,
      participantId: null,
    };
  }
  const c = (await getCollaborations()).find((x) => x.ledger_id === ledger.id);
  if (!c) return null;
  return {
    kind: "collaborator",
    role: "collaborator",
    canCreate: c.can_create,
    canEditOwn: c.can_edit_own,
    canEditAll: c.can_edit_all,
    canViewTax: c.can_view_tax,
    canManage: false,
    participantId: c.participant_id,
  };
}
