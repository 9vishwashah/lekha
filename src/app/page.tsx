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
          <Link href="#guide" className="hidden h-11 items-center rounded-full px-4 text-[15px] font-medium hover:bg-sunken sm:inline-flex">
            How it works
          </Link>
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
            For you <span className="text-ink-3">&amp;</span> your businesses.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-ink-2">
            One place for every khata you keep: clients, suppliers, sites, family and friends. Work out GST and TDS line by line, track
            advances until they come back, split shared costs, and send each person a live statement on WhatsApp.
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

      <Guide />

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm text-ink-3">
        <span>Built for India: ₹, lakh–crore grouping, April financial year.</span>
        <span>Lekha keeps records. It does not file GST or TDS returns.</span>
      </footer>
    </div>
  );
}

const STEPS = [
  {
    title: "Set up in a minute",
    body: "Sign up with email or Google, add your name and mobile, and name a workspace for each business. Personal accounts live alongside.",
    color: "bg-mustard text-ink",
  },
  {
    title: "Add your people",
    body: "Client Accounts hold everyone you deal with: clients, suppliers, vendors, staff, friends. Add them once, use them everywhere.",
    color: "bg-lavender text-ink",
  },
  {
    title: "Open a ledger",
    body: "Basic for money in and out. Taxation for bills with GST and TDS worked out per entry. Shared to split costs with friends or family.",
    color: "bg-pink text-ink",
  },
  {
    title: "Add entries, or import Excel",
    body: "Money in or out takes seconds on your phone. Bring old sheets across with a preview before anything is saved.",
    color: "bg-sky text-ink",
  },
  {
    title: "Share it live",
    body: "Send a read-only link on WhatsApp that updates as you add entries, or invite someone to add entries with you.",
    color: "bg-tea text-seashell",
  },
] as const;

/** A short guide: the five things you do in Lekha, in order. */
function Guide() {
  return (
    <section id="guide" aria-labelledby="guide-title" className="scroll-mt-6 border-t border-line py-14 lg:py-20">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h2 id="guide-title" className="display text-[2.6rem] font-extrabold leading-none sm:text-6xl">
          How it works
        </h2>
        <p className="max-w-sm text-[15px] text-ink-2">Five steps from sign-up to a statement your client opens on WhatsApp.</p>
      </div>
      <ol className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className={`flex min-h-56 flex-col justify-between rounded-[32px] p-6 ${s.color}`}>
            <span className="num display text-6xl font-extrabold leading-none opacity-90">{i + 1}</span>
            <span>
              <span className="display block text-2xl font-bold">{s.title}</span>
              <span className="mt-2 block text-[15px] leading-relaxed opacity-80">{s.body}</span>
            </span>
          </li>
        ))}
        <li className="flex min-h-56 flex-col justify-between rounded-[32px] bg-ink p-6 text-seashell">
          <span className="display text-2xl font-bold">Your books stay yours.</span>
          <span className="flex flex-col gap-4">
            <span className="text-[15px] leading-relaxed opacity-75">
              Every workspace is private. Shared links are read-only and can be turned off any time. Export PDF, Excel or CSV whenever you like.
            </span>
            <LinkButton href="/sign-up" variant="light" className="self-start">
              Start free
            </LinkButton>
          </span>
        </li>
      </ol>
    </section>
  );
}
