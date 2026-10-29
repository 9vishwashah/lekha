import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { Logo } from "@/components/app/logo";
import { getMyProfile, loadMemberships } from "@/lib/server/context";
import { inviteReturnPath } from "@/lib/server/shared";
import { ServiceProblem } from "@/components/app/service-problem";
import { OnboardingForm } from "./form";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";

// Always rendered per request: private data, and configuration is read at runtime.
export const dynamic = "force-dynamic";

export const metadata = { title: "Set up your workspace" };

export default async function Onboarding(props: PageProps<"/onboarding">) {
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  // Set when the person arrived from an invitation: setup returns there afterwards.
  const next = inviteReturnPath(((await props.searchParams) as Record<string, string | undefined>).next);
  const loaded = await loadMemberships();
  if (loaded.problem) return <ServiceProblem kind={loaded.problem.kind} code={loaded.problem.code} />;
  const hasWorkspace = loaded.memberships.length > 0;
  const [user, profile] = await Promise.all([currentUser(), getMyProfile()]);
  if (next && profile) redirect(next);
  if (!next && hasWorkspace) redirect("/dashboard");
  const knownName = profile?.full_name || user?.fullName || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-10 px-4 py-[max(1.5rem,env(safe-area-inset-top))]">
      <Logo />
      <div className="animate-rise">
        <h1 className="display text-5xl font-extrabold sm:text-6xl">{next ? "First, who are you?" : "Let’s set you up"}</h1>
        <p className="mt-3 text-lg text-ink-2">
          {next
            ? "Add your name so the person who invited you knows it’s you. Then you’ll go straight back to the invitation."
            : "Your workspace is your private book. Clients, ledgers and expenses live here, and nobody else sees them unless you invite them."}
        </p>
      </div>
      <OnboardingForm defaultName={knownName} defaultPhone={profile?.phone ?? ""} next={next} askWorkspace={!hasWorkspace} />
    </div>
  );
}
