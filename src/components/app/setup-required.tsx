import { Logo } from "./logo";

export function missingConfig(): string[] {
  return [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SHARE_LINK_SECRET",
  ].filter((k) => !process.env[k]);
}

/** Shown instead of the app when the database is not configured. No demo data is substituted. */
export function SetupRequired({ missing }: { missing: string[] }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-4 py-10">
      <Logo />
      <h1 className="display text-5xl font-extrabold">Finish setting up</h1>
      <p className="text-lg text-ink-2">Lekha needs its database connection before it can show any ledgers. Add these to <code>.env.local</code> and restart:</p>
      <ul className="flex flex-col gap-2 rounded-3xl bg-ink p-5 font-mono text-[14px] text-seashell">
        {missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <p className="text-ink-2">The README walks through creating the Supabase project, running the migrations and connecting Clerk.</p>
    </div>
  );
}
