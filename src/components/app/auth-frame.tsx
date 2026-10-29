import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./logo";

export function AuthFrame({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="mx-auto grid min-h-dvh w-full max-w-6xl items-center gap-8 overflow-x-clip px-4 py-8 lg:grid-cols-2 lg:px-8">
      <div className="flex flex-col gap-6">
        <Link href="/" aria-label="Lekha home">
          <Logo />
        </Link>
        <div>
          <h1 className="display text-5xl font-extrabold sm:text-6xl">{title}</h1>
          <p className="mt-3 text-lg text-ink-2">{body}</p>
        </div>
        <div className="hidden gap-3 lg:flex" aria-hidden>
          <span className="h-24 w-36 rounded-[24px] bg-mustard" />
          <span className="h-24 w-24 rounded-[24px] bg-lavender" />
          <span className="h-24 w-16 rounded-[24px] bg-tea" />
        </div>
      </div>
      <div className="flex justify-center lg:justify-end">{children}</div>
    </div>
  );
}
