"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { acceptInvitation } from "@/app/(app)/actions/workspace";

export function AcceptButton({ token, label = "Accept invitation" }: { token: string; label?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-3">
      <Button
        size="lg"
        className="w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await acceptInvitation(token);
            if (!res.ok) return setError(res.error);
            router.push(res.data!.href);
          })
        }
      >
        {pending ? "Joining…" : label}
      </Button>
      {error && (
        <p role="alert" className="font-medium text-out">
          {error}
        </p>
      )}
    </div>
  );
}
