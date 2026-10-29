import { SignIn } from "@clerk/nextjs";
import { AuthFrame } from "@/components/app/auth-frame";
import { safeReturnPath } from "@/lib/redirect";
import { appUrl } from "@/lib/env";

export const metadata = { title: "Sign in" };

export default async function Page(props: PageProps<"/sign-in/[[...sign-in]]">) {
  const { redirect_url } = (await props.searchParams) as Record<string, string | undefined>;
  const next = safeReturnPath(redirect_url, appUrl());
  return (
    <AuthFrame title="Welcome back" body="Your ledgers are where you left them.">
      <SignIn
        {...(next ? { forceRedirectUrl: next, signUpForceRedirectUrl: next } : { fallbackRedirectUrl: "/dashboard", signUpForceRedirectUrl: "/onboarding" })}
      />
    </AuthFrame>
  );
}
