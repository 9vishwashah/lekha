import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { onColor } from "@/lib/invoices/doc";

/**
 * Link-preview cards (WhatsApp, iMessage, Slack…): 1200×630 PNGs in the app's own look. Seashell
 * canvas, one solid wallet colour, big type, the Lekha mark. No gradients, no shadows.
 */
export const OG_SIZE = { width: 1200, height: 630 };

const INK = "#1d1d1b";
const CANVAS = "#f2eee7";
const SEASHELL = "#eae4da";

/** Wallet colours as hex with the text colour that reads on each (same pairs as the app). */
export const OG_WALLET: Record<string, { bg: string; fg: string }> = {
  mustard: { bg: "#eac119", fg: INK },
  lavender: { bg: "#808bc5", fg: INK },
  tea: { bg: "#245e55", fg: SEASHELL },
  pink: { bg: "#eaa7c7", fg: INK },
  tangerine: { bg: "#ed773c", fg: INK },
  sky: { bg: "#9ed6df", fg: INK },
  red: { bg: "#c63f3e", fg: "#ffffff" },
  ink: { bg: INK, fg: SEASHELL },
};

let fontCache: Promise<{ name: string; data: Buffer; weight: 400 | 600; style: "normal" }[]> | null = null;
function fonts() {
  fontCache ??= (async () => {
    const dir = path.join(process.cwd(), "assets", "fonts");
    const [regular, bold] = await Promise.all([readFile(path.join(dir, "Inter_400Regular.ttf")), readFile(path.join(dir, "Inter_600SemiBold.ttf"))]);
    return [
      { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
      { name: "Inter", data: bold, weight: 600 as const, style: "normal" as const },
    ];
  })();
  return fontCache;
}

/** The Lekha mark (same drawing as components/app/logo.tsx) with the wordmark. */
export function OgLogo({ size = 44, color = INK }: { size?: number; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.32 }}>
      <svg width={size} height={size} viewBox="0 0 30 30">
        <rect x="1" y="5" width="28" height="22" rx="7" fill={INK} />
        <rect x="1" y="3" width="20" height="12" rx="5" fill="#eac119" />
        <circle cx="22" cy="17" r="2.6" fill={SEASHELL} />
      </svg>
      <div style={{ fontSize: size * 0.92, fontWeight: 600, letterSpacing: -1.5, color }}>lekha</div>
    </div>
  );
}

const oneLine = { display: "flex", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;

export interface CardContent {
  /** Small line above the title, e.g. "VJAS · Tax ledger statement". */
  kicker: string;
  title: string;
  /** Under the title, e.g. "with Ramesh Saini". */
  subtitle?: string | null;
  headline: string;
  amount?: string | null;
  chips?: string[];
  /** Footer, e.g. "Shared by Vishwa Shah". */
  footer?: string | null;
  badge: string;
  color: string;
  /** A custom solid colour instead of a wallet colour (a business's brand). */
  hex?: string | null;
  /** The sender's own logo, as a data URI. */
  brandLogo?: string | null;
}

/** `cache`: "private" for anything behind a link token (a revoked link must stop showing at once). */
export async function renderCard(c: CardContent, { cache = "private" }: { cache?: "private" | "public" } = {}) {
  const w = c.hex ? { bg: c.hex, fg: onColor(c.hex) } : (OG_WALLET[c.color] ?? OG_WALLET.mustard);
  const titleSize = c.title.length > 26 ? 64 : c.title.length > 16 ? 80 : 96;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: CANVAS, padding: 44, fontFamily: "Inter", color: INK }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <OgLogo />
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: INK, color: SEASHELL, borderRadius: 999, padding: "10px 22px", fontSize: 24, fontWeight: 600 }}>
            <div style={{ width: 12, height: 12, borderRadius: 999, background: "#7fd1a8" }} />
            {c.badge}
          </div>
        </div>

        <div style={{ marginTop: 28, flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", borderRadius: 44, background: w.bg, color: w.fg, padding: "40px 48px" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {c.brandLogo && (
              <div style={{ display: "flex", background: "#ffffff", borderRadius: 18, padding: 10, marginBottom: 14, alignSelf: "flex-start" }}>
                {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
                <img src={c.brandLogo} height={64} style={{ objectFit: "contain" }} />
              </div>
            )}
            <div style={{ ...oneLine, fontSize: 26, opacity: 0.7 }}>{c.kicker}</div>
            <div style={{ ...oneLine, fontSize: titleSize, fontWeight: 600, letterSpacing: -3, lineHeight: 1.05, marginTop: 6 }}>{c.title}</div>
            {c.subtitle && <div style={{ ...oneLine, fontSize: 30, opacity: 0.75, marginTop: 6 }}>{c.subtitle}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24 }}>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
              <div style={{ ...oneLine, fontSize: 32, fontWeight: 600 }}>{c.headline}</div>
              {c.amount && <div style={{ ...oneLine, fontSize: 96, fontWeight: 600, letterSpacing: -4, lineHeight: 1 }}>{c.amount}</div>}
            </div>
            {c.chips && c.chips.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
                {c.chips.map((chip) => (
                  <div key={chip} style={{ display: "flex", borderRadius: 999, padding: "8px 18px", fontSize: 22, fontWeight: 600, background: w.fg === INK ? "rgba(29,29,27,0.1)" : "rgba(255,255,255,0.14)" }}>
                    {chip}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {c.footer && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 22, fontSize: 26 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: 999, background: INK, color: SEASHELL, fontSize: 22, fontWeight: 600 }}>
              {c.footer.replace(/^(Shared|Invited) by /, "").trim().charAt(0).toUpperCase() || "L"}
            </div>
            <div style={{ ...oneLine, color: "#57534b" }}>{c.footer}</div>
          </div>
        )}
      </div>
    ),
    { ...OG_SIZE, fonts: await fonts(), headers: { "Cache-Control": cache === "public" ? "public, max-age=86400, s-maxage=86400" : "private, no-store" } },
  );
}
