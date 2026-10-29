import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getMyProfile } from "@/lib/server/context";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { Logo } from "@/components/app/logo";
import { LinkButton } from "@/components/ui/button";
import { AcceptButton } from "./accept";
import { type InvitePreview, loadInvitePreview } from "./preview";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";

// Always rendered per request: private data, and configuration is read at runtime.
export const dynamic = "force-dynamic";

const base: Metadata = { title: "Invitation", robots: { index: false }, referrer: "no-referrer" };

/** Link previews (WhatsApp etc.) name the ledger and who sent the invitation. */
export async function generateMetadata(props: PageProps<"/invite/[token]">): Promise<Metadata> {
  const { token } = await props.params;
  const p = await loadInvitePreview(token);
  if (!p || p.status !== "pending") return base;
  const what = p.scope === "ledger" ? `“${p.ledger_name}”` : (p.workspace_name ?? "a workspace");
  const title = `${p.invited_by ?? "Someone"} invited you to ${what}`;
  const description = "Open to join on Lekha. You’ll see only what this invitation covers.";
  return { ...base, title, description, openGraph: { title, description, siteName: "Lekha", type: "website" }, twitter: { card: "summary_large_image", title, description } };
}


export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  const { userId } = await auth();
  let preview: InvitePreview | null = null;
  if (allow(await clientKey("invite"), 30, 60_000)) preview = await loadInvitePreview(token);
  // Someone who just created an account sets up their name first, then comes straight back here.
  if (userId && preview?.status === "pending" && !(await getMyProfile())) {
    redirect(`/onboarding?next=${encodeURIComponent(`/invite/${token}`)}`);
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
