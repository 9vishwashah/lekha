import { SignUp } from "@clerk/nextjs";
import { AuthFrame } from "@/components/app/auth-frame";

export const metadata = { title: "Create account" };

export default function Page() {
  return (
    <AuthFrame title="Open your first khata" body="One account, as many contractors and ledgers as you need.">
      <SignUp />
    </AuthFrame>
  );
}
