import { SignOutButton } from "@clerk/nextjs";
import { Logo } from "./logo";
import type { ServiceProblemKind } from "@/lib/server/context";

const COPY: Record<ServiceProblemKind, { title: string; body: string; owner: string }> = {
  trust: {
    title: "Your sign-in isn’t connected yet",
    body: "You’re signed in, but the database doesn’t recognise this sign-in service yet.",
    owner: "In Supabase → Authentication → Third-Party Auth, add Clerk with this site’s Clerk domain (for production, clerk.<your domain>).",
  },
  role: {
    title: "Your account can’t open its data",
    body: "You’re signed in, but the database treated you as a visitor.",
    owner: "In Clerk (this instance) → Sessions → Customize session token, add {\"role\": \"authenticated\"}. Then sign out and back in.",
  },
  schema: {
    title: "The database needs an update",
    body: "This version of Lekha expects database changes that aren’t in place yet.",
    owner: "Apply every file in supabase/migrations, in order, to the Supabase project this site uses.",
  },
  expired: {
    title: "Your sign-in refreshed",
    body: "Your session renewed while the page was loading. Reload to continue.",
    owner: "If this keeps happening, check the server clock and the region of the deployment.",
  },
  network: {
    title: "We couldn’t reach the database",
    body: "The connection to your data timed out. Nothing you saved is affected.",
    owner: "Check that the Supabase project is running (not paused) and that NEXT_PUBLIC_SUPABASE_URL is correct.",
  },
  unknown: {
    title: "That didn’t load",
    body: "Something went wrong while opening your workspace. Nothing you saved is affected.",
    owner: "Check the deployment logs for the line starting with [db] workspace_members.",
  },
};

/** Shown instead of a bare server error when the first data request after sign-in fails. */
export function ServiceProblem({ kind, code }: { kind: ServiceProblemKind; code: string }) {
  const c = COPY[kind];
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <Logo />
      <div>
        <h1 className="display text-5xl font-extrabold">{c.title}</h1>
        <p className="mt-3 text-lg text-ink-2">{c.body}</p>
      </div>
      <div className="rounded-3xl bg-surface p-5 text-[15px] ring-1 ring-inset ring-line">
        <div className="text-sm font-semibold">If you run this site</div>
        <p className="mt-1 text-ink-2">{c.owner}</p>
        <p className="mt-3 font-mono text-[13px] text-ink-3">
          {kind}
          {code ? ` · ${code}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href="" className="inline-flex h-12 items-center rounded-full bg-ink px-5 font-medium text-surface">
          Reload
        </a>
        <SignOutButton>
          <button type="button" className="inline-flex h-12 items-center rounded-full px-5 font-medium ring-1 ring-inset ring-line">
            Sign out
          </button>
        </SignOutButton>
      </div>
    </div>
  );
}
