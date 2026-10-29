import { UserProfile } from "@clerk/nextjs";
import { PageHeader } from "@/components/ui/bits";

export const metadata = { title: "Account" };

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Account" kicker="Settings" />
      <div className="flex justify-center overflow-x-auto">
        <UserProfile path="/settings/account" />
      </div>
    </div>
  );
}
