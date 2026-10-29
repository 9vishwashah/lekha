import { SignUp } from "@clerk/nextjs";
import { AuthFrame } from "@/components/app/auth-frame";
import { safeReturnPath } from "@/lib/redirect";
import { appUrl } from "@/lib/env";

export const metadata = { title: "Create account" };

export default async function Page(props: PageProps<"/sign-up/[[...sign-up]]">) {
  const { redirect_url } = (await props.searchParams) as Record<string, string | undefined>;
  // A new account always lands somewhere that asks for the name and workspace first: the setup page,
  // or the invitation it came from (which sends to setup and then back).
  const next = safeReturnPath(redirect_url, appUrl()) ?? "/onboarding";
  return (
    <AuthFrame title="Open your first khata" body="One account for you and every business you run. Add as many ledgers and people as you need.">
      <SignUp forceRedirectUrl={next} signInForceRedirectUrl={next} />
    </AuthFrame>
  );
}
