import { SignIn } from "@clerk/nextjs";
import { AuthFrame } from "@/components/app/auth-frame";

export const metadata = { title: "Sign in" };

export default function Page() {
  return (
    <AuthFrame title="Welcome back" body="Your ledgers are where you left them.">
      <SignIn />
    </AuthFrame>
  );
}
