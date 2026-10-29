import { OG_SIZE, renderCard } from "@/lib/og";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { loadInvitePreview } from "./preview";

export const alt = "Invitation on Lekha";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preview = allow(await clientKey("invite-card"), 30, 60_000) ? await loadInvitePreview(token) : null;
  if (!preview || preview.status !== "pending") {
    return renderCard({ kicker: "Lekha", title: "Invitation", headline: "This invitation is no longer open", badge: "Invite", color: "ink" });
  }
  const ledger = preview.scope === "ledger";
  return renderCard({
    kicker: ledger ? [preview.workspace_name, preview.ledger_type === "personal" ? "Shared account" : "Ledger"].filter(Boolean).join(" · ") : "Workspace",
    title: (ledger ? preview.ledger_name : preview.workspace_name) ?? "Lekha",
    subtitle: preview.participant_name ? `as ${preview.participant_name}` : null,
    headline: ledger ? "You’re invited to add entries and follow along live" : `You’re invited to join as ${preview.role ?? "member"}`,
    footer: preview.invited_by ? `Invited by ${preview.invited_by}` : null,
    badge: "Invitation",
    color: preview.ledger_type === "personal" ? "pink" : preview.ledger_type === "taxation" ? "lavender" : "mustard",
  });
}
