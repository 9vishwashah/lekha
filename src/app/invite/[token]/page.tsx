import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { anonDb } from "@/lib/supabase/server";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { isTokenShape } from "@/lib/server/shared";
import { Logo } from "@/components/app/logo";
import { LinkButton } from "@/components/ui/button";
import { AcceptButton } from "./accept";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";

// Always rendered per request: private data, and configuration is read at runtime.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Invitation", robots: { index: false }, referrer: "no-referrer" };

interface Preview {
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

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  const { userId } = await auth();
  let preview: Preview | null = null;
  if (isTokenShape(token) && allow(await clientKey("invite"), 30, 60_000)) {
    const { data } = await anonDb().rpc("get_invitation_preview", { p_token: token });
    preview = (data as Preview | null) ?? null;
  }

  const title = !preview
    ? "Invitation not found"
    : preview.scope === "workspace"
      ? `Join ${preview.workspace_name}`
      : `Join “${preview.ledger_name}”`;

  const can = preview?.permissions ?? {};
  const abilities =
    preview?.scope === "workspace"
      ? [`Role: ${preview.role}`]
      : [
          "View this ledger and its balance",
          can.can_create && "Add new entries",
          can.can_edit_all ? "Change any entry" : can.can_edit_own && "Change entries you add",
          can.can_view_tax && "See tax details",
        ].filter(Boolean);

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-8 px-4 py-10">
      <Logo />
      <div>
        <h1 className="display text-5xl font-extrabold">{title}</h1>
        {preview && preview.status === "pending" && (
          <p className="mt-3 text-lg text-ink-2">
            {preview.invited_by ?? "Someone"} invited you{preview.participant_name ? ` as ${preview.participant_name}` : ""}. You will see only what this invitation
            covers.
          </p>
        )}
      </div>
      {!preview || preview.status !== "pending" ? (
        <p className="rounded-3xl bg-surface p-5 text-ink-2 ring-1 ring-inset ring-line">
          {preview?.status === "accepted"
            ? "This invitation has already been used."
            : preview?.status === "expired"
              ? "This invitation has expired."
              : "This invitation is not valid or was cancelled."}{" "}
          Ask for a new one.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2 rounded-3xl bg-surface p-5 ring-1 ring-inset ring-line">
            {abilities.map((a) => (
              <li key={String(a)} className="text-[15px]">
                · {a}
              </li>
            ))}
          </ul>
          {userId ? (
            <AcceptButton token={token} />
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <LinkButton href={`/sign-up?redirect_url=${encodeURIComponent(`/invite/${token}`)}`} size="lg">
                Create account to join
              </LinkButton>
              <LinkButton href={`/sign-in?redirect_url=${encodeURIComponent(`/invite/${token}`)}`} size="lg" variant="secondary">
                I have an account
              </LinkButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}
