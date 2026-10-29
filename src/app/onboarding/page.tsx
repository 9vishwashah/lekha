import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { Logo } from "@/components/app/logo";
import { getMemberships } from "@/lib/server/context";
import { OnboardingForm } from "./form";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";

// Always rendered per request: private data, and configuration is read at runtime.
export const dynamic = "force-dynamic";

export const metadata = { title: "Set up your workspace" };

export default async function Onboarding() {
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  const memberships = await getMemberships();
  if (memberships.length) redirect("/dashboard");
  const user = await currentUser();
  const first = user?.firstName || user?.username || "My";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-10 px-4 py-[max(1.5rem,env(safe-area-inset-top))]">
      <Logo />
      <div className="animate-rise">
        <h1 className="display text-5xl font-extrabold sm:text-6xl">Name your workspace</h1>
        <p className="mt-3 text-lg text-ink-2">
          This is your private book. Contractors, ledgers and expenses live here, and nobody else sees them unless you invite them.
        </p>
      </div>
      <OnboardingForm suggestion={`${first}${first.endsWith("s") ? "’" : "’s"} business`} />
    </div>
  );
}
