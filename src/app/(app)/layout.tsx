import Link from "next/link";
import { cookies } from "next/headers";
import { UserButton } from "@clerk/nextjs";
import { BottomNav, QuickAddButton, Sidebar } from "@/components/app/nav";
import { WorkspaceSwitcher } from "@/components/app/workspace-switcher";
import { Logo } from "@/components/app/logo";
import { SwipeNav } from "@/components/app/swipe-nav";
import { WORKSPACE_COOKIE, getCollaborations, loadMemberships } from "@/lib/server/context";
import { ServiceProblem } from "@/components/app/service-problem";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";

// Always rendered per request: private data, and configuration is read at runtime.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  const [loaded, shared] = await Promise.all([loadMemberships(), getCollaborations()]);
  if (loaded.problem) return <ServiceProblem kind={loaded.problem.kind} code={loaded.problem.code} />;
  const memberships = loaded.memberships;
  const chosen = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const current = memberships.find((m) => m.workspace.id === chosen) ?? memberships[0];
  const hasWorkspace = memberships.length > 0;
  const options = memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role }));

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1440px]">
      <aside className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-6 px-4 py-6 lg:flex">
        <Link href="/dashboard" className="px-3">
          <Logo />
        </Link>
        {hasWorkspace && (
          <div className="rounded-3xl bg-surface px-4 py-3 ring-1 ring-inset ring-line/70">
            <div className="text-xs text-ink-3">Workspace</div>
            <WorkspaceSwitcher current={current.workspace.id} options={options} />
          </div>
        )}
        {hasWorkspace && <QuickAddButton className="w-full" />}
        <Sidebar hasWorkspace={hasWorkspace} sharedCount={shared.length} />
        <div className="mt-auto flex items-center gap-3 px-3">
          <UserButton />
          <span className="text-sm text-ink-2">Account</span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex items-center justify-between gap-3 bg-canvas/90 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-md lg:hidden">
          <Link href="/dashboard" aria-label="Home">
            <Logo compact />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            {hasWorkspace && <WorkspaceSwitcher current={current.workspace.id} options={options} />}
            <UserButton />
          </div>
        </header>
        <main id="main" className="w-full min-w-0 flex-1 overflow-x-clip px-4 pb-32 pt-2 sm:px-6 lg:px-10 lg:pb-16 lg:pt-8">
          <SwipeNav>{children}</SwipeNav>
        </main>
      </div>
      <BottomNav hasWorkspace={hasWorkspace} />
    </div>
  );
}
