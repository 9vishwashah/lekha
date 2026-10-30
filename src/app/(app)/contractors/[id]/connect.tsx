"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { Avatar } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { AddByUsername } from "@/components/app/add-by-username";
import { linkClient, unlinkClient } from "@/app/(app)/actions/people";
import { whatsappUrl } from "@/components/app/share-sheet";

/**
 * Links this client record to the person's own Lekha account by their exact @username. Once
 * linked, shared accounts with them show up in their Lekha automatically. Not on Lekha yet: send
 * them a note to sign up, then link them.
 */
export function ConnectCard({
  contractor,
  account,
  canWrite,
  whatsappTo,
}: {
  contractor: { id: string; name: string };
  account: { username: string | null; fullName: string; photo: string | null } | null;
  canWrite: boolean;
  whatsappTo: string | null;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const first = contractor.name.split(/\s+/)[0];

  if (account) {
    return (
      <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-tea p-5 text-seashell sm:flex-row sm:items-center sm:p-6">
        <Avatar name={account.fullName} src={account.photo} tone="light" className="size-12" />
        <div className="min-w-0 flex-1">
          <p className="display text-xl font-bold">On Lekha{account.username ? ` as @${account.username}` : ""}</p>
          <p className="mt-1 text-[14px] opacity-80">
            Shared accounts with {first} show up in their Lekha automatically. They never see the rest of your books.
          </p>
        </div>
        {canWrite && (
          <Button
            variant="light"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Unlink ${contractor.name}? They lose access to your shared accounts. Every entry stays.`)) return;
              start(async () => {
                const res = await unlinkClient(contractor.id);
                if (!res.ok) return void toast.error(res.error);
                toast.success(res.message ?? "Unlinked");
                router.refresh();
              });
            }}
          >
            Unlink
          </Button>
        )}
      </section>
    );
  }

  if (!canWrite) return null;

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-inset ring-line/70 sm:p-6">
      <div className="flex items-start gap-4">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-sunken">
          <Link2 className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="display text-xl font-bold">Link {first}’s Lekha account</p>
          <p className="mt-1 text-[14px] text-ink-2">
            Type their username. Your shared accounts then show up in their Lekha too, with no links to send.
          </p>
        </div>
      </div>
      <AddByUsername
        label={`${first}’s username`}
        actionLabel="Link"
        onAdd={async (username) => {
          const res = await linkClient(contractor.id, username);
          if (!res.ok) {
            toast.error(res.error);
            return false;
          }
          toast.success(res.message ?? "Linked");
          router.refresh();
          return true;
        }}
        inviteLabel={`Ask ${first} to join on WhatsApp`}
        onInviteLink={() =>
          window.open(
            whatsappUrl(`Hi ${first}, I keep our accounts on Lekha. Sign up at ${window.location.origin} and send me your username so I can add you.`, whatsappTo),
            "_blank",
            "noopener,noreferrer",
          )
        }
      />
    </section>
  );
}
