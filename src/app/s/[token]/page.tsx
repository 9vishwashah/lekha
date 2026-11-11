import { ExportLink } from "@/components/app/export-link";
import type { Metadata } from "next";
import { Download } from "lucide-react";
import { loadShareCard, loadSharedOnce, summarizeShare } from "@/lib/server/share-card";
import { allow, clientKey } from "@/lib/server/rate-limit";
import { todayISO } from "@/lib/domain/dates";
import { walletOf } from "@/components/ui/bits";
import { CashView, PersonalView } from "@/components/app/public-ledger";
import { Logo } from "@/components/app/logo";
import { SharedLive } from "./live";
import { AcknowledgeButton } from "@/components/app/share-acknowledge";
import { SetupRequired, missingConfig } from "@/components/app/setup-required";

// Always rendered per request: private data, and configuration is read at runtime.
export const dynamic = "force-dynamic";

const base: Metadata = { title: "Ledger statement", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** WhatsApp and other apps show this as the link preview: the ledger, its balance and the sender. */
export async function generateMetadata(props: PageProps<"/s/[token]">): Promise<Metadata> {
  const { token } = await props.params;
  const [shared, card] = await Promise.all([loadSharedOnce(token), loadShareCard(token)]);
  if (!shared) return base;
  const s = summarizeShare(shared, card);
  const title = `${s.ledgerName}${s.sharedBy ? ` · from ${s.sharedBy}` : ""}`;
  return {
    ...base,
    title,
    description: s.description,
    openGraph: { title, description: s.description, siteName: "Lekha", type: "website" },
    twitter: { card: "summary_large_image", title, description: s.description },
  };
}

const COLOR = { basic: "mustard", taxation: "lavender", personal: "pink" } as const;

export default async function SharedLedger(props: PageProps<"/s/[token]">) {
  const { token } = await props.params;
  const missing = missingConfig();
  if (missing.length) return <SetupRequired missing={missing} />;
  if (!allow(await clientKey("share-page"), 60, 60_000)) return <Inactive title="Too many requests" body="Wait a minute and refresh the page." />;
  const [shared, card] = await Promise.all([loadSharedOnce(token), loadShareCard(token)]);
  if (!shared) return <Inactive title="This link is no longer active" body="Ask the person who sent it for a new link." />;

  const { ledger, options } = shared;
  // The ledger's own colour, as the owner sees it.
  const w = walletOf(card?.color ?? COLOR[ledger.ledger_type]);
  const today = todayISO();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 overflow-x-clip px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Logo compact />
          <span className="truncate text-sm text-ink-3">
            {card?.shared_by ? `from ${card.shared_by}${card.business ? ` · ${card.business}` : ""}` : "Statement shared with you"}
          </span>
        </div>
        <SharedLive token={token} version={ledger.last_activity_at} />
      </header>

      {ledger.ledger_type === "personal" ? (
        <PersonalView shared={shared} wBg={`${w.bg} ${w.fg}`} today={today} />
      ) : (
        <CashView
          shared={shared}
          wBg={`${w.bg} ${w.fg}`}
          wSub={w.sub}
          today={today}
          searchAction={<AcknowledgeButton token={token} version={ledger.last_activity_at} ack={shared.acknowledgement ?? null} suggestedName={ledger.contractor_name} />}
        />
      )}

      {/* Floats over a long list so the download is always one tap away. */}
      <div className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 flex justify-end gap-2 self-end">
        <ExportLink
          href={`/api/share/${token}?format=pdf`}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-5 font-medium text-surface shadow-[0_12px_32px_rgb(29_29_27/0.28)]"
        >
          <Download className="size-4" /> PDF
        </ExportLink>
        <ExportLink
          href={`/api/share/${token}?format=csv`}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-surface px-5 font-medium ring-1 ring-inset ring-line shadow-[0_12px_32px_rgb(29_29_27/0.18)]"
        >
          CSV
        </ExportLink>
      </div>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[13px] text-ink-3">
        <Logo compact />
        <span>Read-only. Only what the owner chose to share is shown.{options.show_balance ? "" : " Balances are hidden."}</span>
      </footer>
    </div>
  );
}

function Inactive({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4">
      <Logo />
      <h1 className="display text-5xl font-extrabold">{title}</h1>
      <p className="text-lg text-ink-2">{body}</p>
    </div>
  );
}
