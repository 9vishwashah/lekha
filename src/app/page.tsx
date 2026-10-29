import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ArrowUpRight } from "lucide-react";
import { Logo } from "@/components/app/logo";
import { LinkButton } from "@/components/ui/button";

export default async function Landing() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col overflow-x-clip px-4 pb-10 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8">
      <nav className="flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-2">
          <Link href="/sign-in" className="hidden h-11 items-center rounded-full px-4 text-[15px] font-medium hover:bg-sunken sm:inline-flex">
            Sign in
          </Link>
          <LinkButton href="/sign-up" size="sm">
            Create account
          </LinkButton>
        </div>
      </nav>

      <section className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[1.15fr_1fr] lg:py-20">
        <div className="animate-rise">
          <h1 className="display max-w-4xl text-[3.4rem] font-extrabold sm:text-7xl lg:text-[5.6rem]">
            Every contractor’s <span className="text-ink-3">khata,</span> settled.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-ink-2">
            Keep ledgers for every contractor, work out GST and TDS line by line, track advances until they come back, and send each
            person a live statement on WhatsApp.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton href="/sign-up" size="lg">
              Start a ledger
            </LinkButton>
            <LinkButton href="/sign-in" size="lg" variant="secondary">
              I have an account
            </LinkButton>
          </div>
        </div>

        {/* A stack of wallet cards: the three ledger types, as they appear in the app. */}
        <div className="relative mx-auto w-full max-w-md animate-rise [animation-delay:120ms]" aria-hidden>
          <div className="rounded-[32px] bg-lavender p-6 text-ink">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-medium opacity-70">Rishabh Sales & Creative</div>
                <div className="mt-0.5 text-sm font-semibold">Taxation ledger</div>
              </div>
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-white/80">
                <ArrowUpRight className="size-5" />
              </span>
            </div>
            <div className="num display mt-8 text-[2.6rem] font-extrabold">
              ₹11,70,000
            </div>
            <div className="mt-1 text-sm opacity-70">after TDS on ₹10,00,000 + 18% GST</div>
          </div>
          <div className="relative -mt-5 ml-6 rounded-[32px] bg-mustard p-6 sm:ml-10">
            <div className="text-sm font-medium opacity-70">Ramesh Saini · site work</div>
            <div className="num display mt-6 text-[2.2rem] font-extrabold">
              ₹1,17,000
            </div>
            <div className="mt-3 flex gap-2 text-xs font-medium">
              <span className="rounded-full bg-ink/10 px-2.5 py-1">32 entries</span>
              <span className="rounded-full bg-ink/10 px-2.5 py-1">Shared on WhatsApp</span>
            </div>
          </div>
          <div className="relative -mt-5 mr-6 rounded-[32px] bg-ink p-6 text-seashell sm:mr-10">
            <div className="text-sm opacity-60">Vishwa × Suraj</div>
            <div className="mt-3 flex items-end justify-between gap-4">
              <div className="display text-2xl font-bold">Suraj owes you</div>
              <div className="num display text-[2rem] font-extrabold text-mustard">₹400</div>
            </div>
          </div>
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm text-ink-3">
        <span>Built for India: ₹, lakh–crore grouping, April financial year.</span>
        <span>Lekha keeps records. It does not file GST or TDS returns.</span>
      </footer>
    </div>
  );
}
