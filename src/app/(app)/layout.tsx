import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { BottomNav, QuickAddButton, Sidebar } from "@/components/app/nav";
import { WorkspaceSwitcher } from "@/components/app/workspace-switcher";
import { Logo } from "@/components/app/logo";
import { SwipeNav } from "@/components/app/swipe-nav";
import { PendingNavProvider } from "@/components/app/pending-nav";
import { WORKSPACE_COOKIE, getCollaborations, getMyProfile, loadMemberships, requireUser, sharedWithMeHere } from "@/lib/server/context";
import { AccountMenu } from "@/components/app/account-menu";
import { NotificationBell } from "@/components/app/notification-bell";
import { unreadNotifications } from "./actions/notifications";
import { avatarUrl } from "@/lib/avatar";
import { ServiceProblem } from "@/components/app/service-problem";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";

// Always rendered per request: private data, and configuration is read at runtime.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  const [loaded, shared, profile, userId, unread] = await Promise.all([
    loadMemberships(),
    getCollaborations(),
    getMyProfile(),
    requireUser(),
    unreadNotifications().catch(() => 0),
  ]);
  if (loaded.problem) return <ServiceProblem kind={loaded.problem.kind} code={loaded.problem.code} />;
  // Everyone picks a username once; it is how people add each other.
  if (!profile?.username) redirect("/onboarding");
  const me = { name: profile.full_name, username: profile.username, photo: avatarUrl(profile.avatar_path) };
  const memberships = loaded.memberships;
  const chosen = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const current = memberships.find((m) => m.workspace.id === chosen) ?? memberships[0];
  const hasWorkspace = memberships.length > 0;
  const options = memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role }));
  const sharedHere = sharedWithMeHere(memberships, current?.workspace.id, userId, shared);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1440px]">
      <aside className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-6 px-4 py-6 lg:flex">
        <div className="flex items-center justify-between gap-2 px-3">
          <Link href="/dashboard">
            <Logo />
          </Link>
          <NotificationBell initial={unread} userId={userId} />
        </div>
        {hasWorkspace && <WorkspaceSwitcher current={current.workspace.id} options={options} />}
        {hasWorkspace && <QuickAddButton className="w-full" />}
        <Sidebar hasWorkspace={hasWorkspace} showShared={sharedHere.visible} sharedCount={sharedHere.items.length} />
        <div className="mt-auto">
          <AccountMenu name={me.name} username={me.username} photo={me.photo} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex items-center justify-between gap-3 bg-canvas/90 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-md lg:hidden">
          <Link href="/dashboard" aria-label="Home">
            <Logo compact />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            {hasWorkspace && <WorkspaceSwitcher current={current.workspace.id} options={options} compact />}
            <NotificationBell initial={unread} userId={userId} />
            <AccountMenu name={me.name} username={me.username} photo={me.photo} compact />
          </div>
        </header>
        <main id="main" className="w-full min-w-0 flex-1 overflow-x-clip px-4 pb-32 pt-2 sm:px-6 lg:px-10 lg:pb-16 lg:pt-8">
          <SwipeNav>
            <PendingNavProvider>{children}</PendingNavProvider>
          </SwipeNav>
        </main>
      </div>
      <BottomNav hasWorkspace={hasWorkspace} showShared={sharedHere.visible} />
    </div>
  );
}
