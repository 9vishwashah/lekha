"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { switchWorkspace } from "@/app/(app)/actions/workspace";
import { Button } from "@/components/ui/button";

/** Opens the person's own workspace, where what others share with them is listed. */
export function SwitchToWorkspace({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          await switchWorkspace(id);
          router.refresh();
        })
      }
    >
      {pending ? "Opening…" : `Open ${name}`}
    </Button>
  );
}
