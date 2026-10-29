# Design System: Lekha

Reference boards in `design/references/`: the seashell/muted-black colour-block palette, the "Check your team space" type scale, solid wallet cards, and the floating pill navigation.

## 1. Atmosphere

A daily-use money book that feels like a well-made physical wallet: warm seashell paper, ink-black type, and each ledger a solid block of colour you can recognise across the room. Balanced density (it is a work tool), restrained motion, offset layouts. The one memorable element is the **amount**: big, tight, heavy rupees with the paise set light, everywhere money appears.

## 2. Colour

| Token | Hex | Role |
| --- | --- | --- |
| Canvas | `#F2EEE7` | page background |
| Surface | `#FBFAF7` | cards, sheets, inputs sit on white `#FFFFFF` |
| Sunken | `#E9E3D8` | segmented tracks, skeletons, quiet chips |
| Line | `#DDD5C7` | 1px inset rings, dividers |
| Ink | `#1D1D1B` | text, primary buttons, dark cards, focus ring |
| Ink 2 / 3 | `#57534B` / `#6F6A60` | secondary and tertiary text (AA on canvas) |
| Mustard | `#EAC119` | Basic ledgers, add button in the pill nav |
| Lavender | `#808BC5` | Taxation ledgers, tax panels |
| Pink quartz | `#EAA7C7` | Shared accounts, advances |
| Tea | `#245E55` | Money in blocks (seashell text) |
| Sky, Tangerine, Red | `#9ED6DF`, `#ED773C`, `#C63F3E` | extra ledger colours; red also for destructive |
| Money in / out text | `#1F6B5F` / `#B33A39` | amounts in lists (AA on surface) |

Solid fills only. No gradients, glows, glass, or 3D KPI tiles. Ledger colour is chosen per ledger; text colour on each block is fixed in `WALLET` (`src/components/ui/bits.tsx`) to keep contrast.

## 3. Type

- **Display:** Bricolage Grotesque (variable `opsz`, `wdth`), weights 700–800, tracking −0.035em, line-height 0.92. Page titles, hero balances, sheet titles. Never for body copy.
- **Body / UI:** Geist, 15–16px, regular and medium.
- **Numbers:** Geist with tabular figures (`.num`). Voucher numbers in Geist Mono.
- **Amount treatment** (`<Amount>`): `₹1,17,000` heavy + `.00` at 45% opacity, Indian grouping, a real minus sign (−) for negatives.
- Sizes: hero 52–72px · page title 42–60px · section 26–30px · body 15–16px · meta 13px. Inputs are 16px minimum (no iOS zoom).

## 4. Components

- **Wallet card**: solid colour, 28–32px radius, name small at top, balance as hero, meaning line beneath ("You owe Rishabh Sales", "Balance"), chips in a translucent tint. Arrow badge rotates 45° on hover.
- **Buttons**: pill, 40/48/56px heights. Primary ink on seashell text; secondary surface with an inset line; ghost for tertiary. 1px press-down on active. Icon-only buttons are 44px and always labelled.
- **Segmented control**: sunken track, ink thumb; Money In thumb is tea, Money Out thumb is red.
- **Sheets**: native `<dialog>`; bottom sheet with grabber on phones, centred panel on larger screens; sticky footer with the primary action.
- **Fields**: label above, hint or error below, 16px radius, inset ring, 2px ink focus ring, red ring when invalid.
- **Lists**: phones get day-grouped cards with direction badges; tablets and up get a real ledger table with an ink header row.
- **Empty states**: dashed outline, one sentence of direction, one action.
- **Loading**: skeleton blocks in the shape of the page, not spinners.

## 5. Layout

- Mobile first. 16px gutters, single column under 640px. Floating ink pill nav (Home, Ledgers, **+**, Contractors, More) on phones; a 256px sidebar with workspace switcher and **New** on desktop. Max content width 1440px.
- Action rows scroll horizontally on phones instead of wrapping. Extra filters fold into a disclosure.
- `min-h-dvh` and safe-area insets everywhere fixed elements sit.

## 6. Motion

Short and purposeful: a 360ms rise on page entry and staggered wallet cards, a 280ms sheet slide, 150ms press feedback. Only `transform` and `opacity` animate. `prefers-reduced-motion` turns it all off.

## 7. Never

Emojis as icons, gradients or glows, 3D/skeuomorphic KPI tiles, three identical feature cards, pure `#000`, placeholder-only labels, colour as the only signal (amounts also say "credit/debit", statuses have words), adding cash, receivables and advances into one total.
