import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getMyProfile } from "@/lib/server/context";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { Logo } from "@/components/app/logo";
import { LinkButton } from "@/components/ui/button";
import { Avatar, walletOf } from "@/components/ui/bits";
import { CashView, PersonalView } from "@/components/app/public-ledger";
import { loadInvitationLedger } from "@/lib/server/shared";
import { avatarUrl } from "@/lib/avatar";
import { todayISO } from "@/lib/domain/dates";
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
  const open = preview?.status === "pending";
  // Someone who just created an account picks their name and username first, then comes straight back.
  if (userId && open && !(await getMyProfile())?.username) {
    redirect(`/onboarding?next=${encodeURIComponent(`/invite/${token}`)}`);
  }
  const ledger = open && preview?.scope === "ledger" ? await loadInvitationLedger(token) : null;
  const here = encodeURIComponent(`/invite/${token}`);
  const what = preview?.scope === "workspace" ? preview.workspace_name : preview?.ledger_name;
  const w = walletOf(preview?.ledger_type === "personal" ? "pink" : preview?.ledger_type === "taxation" ? "lavender" : "mustard");

  const can = preview?.permissions ?? {};
  const abilities =
    preview?.scope === "workspace"
      ? [`Join as ${preview.role}`]
      : [
          preview?.ledger_type === "personal" ? "See your side of every shared expense" : "See this ledger and its balance, live",
          can.can_create && (preview?.ledger_type === "personal" ? "Add expenses" : "Add new entries"),
          can.can_edit_all ? "Change any entry" : can.can_edit_own && "Change entries you add",
          can.can_view_tax && "See tax details",
        ].filter(Boolean);

  if (!preview || !open) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-8 px-4 py-10">
        <Logo />
        <h1 className="display text-5xl font-extrabold">{preview ? "This invite is closed" : "Invitation not found"}</h1>
        <p className="rounded-3xl bg-surface p-5 text-ink-2 ring-1 ring-inset ring-line">
          {preview?.status === "accepted"
            ? "This invite link has already been used."
            : preview?.status === "expired"
              ? "This invite link has expired."
              : "This invite link is not valid or was cancelled."}{" "}
          Ask for a new one, or ask them to add you by your Lekha username.
        </p>
      </div>
    );
  }

  const join = userId ? (
    <AcceptButton token={token} label={preview.scope === "workspace" ? `Join ${what}` : "Join this ledger"} />
  ) : (
    <div className="flex flex-col gap-2 sm:flex-row">
      <LinkButton href={`/sign-up?redirect_url=${here}`} size="lg">
        Sign up to join
      </LinkButton>
      <LinkButton href={`/sign-in?redirect_url=${here}`} size="lg" variant="secondary">
        I have an account
      </LinkButton>
    </div>
  );

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 overflow-x-clip px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
      <header className="flex items-center justify-between gap-3">
        <Logo compact />
        <span className="text-sm text-ink-3">Invitation</span>
      </header>

      <section className="flex flex-col gap-5 rounded-[32px] bg-ink p-6 text-seashell sm:flex-row sm:items-center sm:p-8">
        <Avatar name={preview.invited_by ?? "?"} src={avatarUrl(preview.invited_by_avatar)} tone="light" className="size-16 text-xl" />
        <div className="min-w-0 flex-1">
          <p className="text-sm opacity-70">{preview.invited_by ?? "Someone"} invited you to</p>
          <h1 className="display mt-1 text-[2.2rem] font-extrabold leading-none sm:text-5xl">{what}</h1>
          <ul className="mt-4 flex flex-wrap gap-2 text-[13px]">
            {abilities.map((a) => (
              <li key={String(a)} className="rounded-full bg-white/10 px-3 py-1">
                {a}
              </li>
            ))}
          </ul>
        </div>
        <div className="sm:w-56">{join}</div>
      </section>

      {ledger && (
        <>
          <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Preview · read-only</p>
          {ledger.ledger.ledger_type === "personal" ? (
            <PersonalView shared={ledger} wBg={`${w.bg} ${w.fg}`} today={todayISO()} />
          ) : (
            <CashView shared={ledger} wBg={`${w.bg} ${w.fg}`} wSub={w.sub} today={todayISO()} />
          )}
          <div className="rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line">
            <p className="mb-3 font-semibold">{userId ? "Ready to join?" : "Sign up to join and keep this in your Lekha."}</p>
            {join}
          </div>
        </>
      )}
    </div>
  );
}
