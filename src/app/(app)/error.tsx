"use client";
import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 py-16">
      <h1 className="display text-5xl font-extrabold">That didn’t load</h1>
      <p className="text-lg text-ink-2">
        We couldn’t reach your data just now. Nothing you saved is affected. Check your connection and try again.
      </p>
      <Button onClick={reset} className="self-start" size="lg">
        Try again
      </Button>
    </div>
  );
}
