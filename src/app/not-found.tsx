import { LinkButton } from "@/components/ui/button";
import { Logo } from "@/components/app/logo";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-5 px-4">
      <Logo />
      <h1 className="display text-6xl font-extrabold">Not here</h1>
      <p className="text-lg text-ink-2">This page doesn’t exist, or you don’t have access to it.</p>
      <LinkButton href="/dashboard" className="self-start" size="lg">
        Go to your ledgers
      </LinkButton>
    </div>
  );
}
