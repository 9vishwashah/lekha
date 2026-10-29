# Lekha

Contractor ledgers, GST/TDS bills, advances, expenses and shared personal accounts, with live statements you can send on WhatsApp. Mobile first, multi-tenant, built for India (₹, lakh–crore grouping, April financial year, Asia/Kolkata).

- **Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) · Tailwind CSS 4 · Clerk (Core 3) · Supabase Postgres with Row Level Security · Zod 4 · ExcelJS · pdf-lib
- **Docs:** [Accounting & permissions design](docs/ACCOUNTING.md) · [Importing your Excel sheets](docs/IMPORT.md) · [Design system](DESIGN.md)

## What it does

| Area | Highlights |
| --- | --- |
| Ledgers | Basic (SR/DATE/PAYEE/CREDIT/DEBIT), Taxation (bill, GST, TDS, after TDS), and Personal & Shared accounts. Cash-book or party-account balance meaning, opening balance, voucher numbers, drafts, void, reversal, controlled amendments. |
| Tax | Configurable GST rate, CGST/SGST or IGST, TDS rate and base (taxable or gross), rates frozen per bill, step-by-step explanation, GST/TDS payments to Government, monthly summary by invoice or entry date. |
| Advances | Given, recovered in cash (Money In), adjusted against bills (no cash), outstanding, overdue, never over-allocated. |
| Expenses | Categories (custom too), optional "paid from a ledger" that writes exactly one linked Money Out entry atomically. |
| Shared accounts | Everyone is a client account, so balances roll up to Home and client pages. One canonical record per expense; equal, exact, % and share-unit splits; multiple payers; repayments that never count as expenses; each person sees "You owe" / "Owed to you" from their side. |
| Sharing | Read-only public link per ledger (hashed token, revoke, rotate, expiry, field-level options), live updates, WhatsApp share. Authenticated editing only through an explicit invitation with granular permissions. |
| Import / export | .xlsx import with sheet picker, header detection, column mapping, row-by-row validation and atomic commit. Excel, CSV, PDF and print for every statement and report. |
| Audit | Append-only, trigger-written history of every change with actor and role (owner/member/collaborator). |

## Run it locally

Requirements: Node 20.9+ (24 recommended), a Clerk application, a Supabase project.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in `.env.local` (see [Configuration](#configuration)), then:

```bash
npm run dev
```

Open http://localhost:3000. Without the database variables the app shows a **Finish setting up** screen rather than fake data.

### Checks

```bash
npm run check
```

That runs `tsc`, ESLint, the Vitest suites and a production build. Individually: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

- `tests/unit` – money, tax engine (including the ₹10,00,000 → ₹11,70,000 workbook example), ledger running balances and date ranges, split engine (equal/uneven/multi-payer/partial and full settlement), advances, tax summary, import parser on generated workbooks shaped like the supplied sheets, export reconciliation (CSV/XLSX/PDF), share-token sealing.
- `tests/db` – applies every migration to an in-process Postgres (PGlite) with the same `auth.jwt()` surface Supabase provides, then checks RLS and the RPCs as real users: cross-tenant reads/writes, forged workspace ids, column-hidden GSTIN/PAN, public link scope/revocation/expiry, collaborator scope and permission limits, audit attribution, atomic rollback, idempotent retries, over-recovery and overpayment blocking, serialised concurrent repayments, import double-commit, and SQL ↔ TypeScript tax parity. Also runs the seed.
- `tests/e2e` – Playwright flows against a real Clerk + Supabase setup (sign-in, contractor, ledgers, entries, balances, share link, live update, revoke, taxation, exports, advances, expenses, import, isolation between two users, collaborator invite/revoke, phone-width overflow). They skip with a message until `E2E_*` users are configured:

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

## Configuration

### 1. Supabase

1. Create a project (any region; `ap-south-1` Mumbai is closest for India).
2. Apply the migrations in `supabase/migrations` in order. Either with the CLI:
   ```bash
   npx supabase link --project-ref <your-project-ref>
   ```
   ```bash
   npx supabase db push
   ```
   or paste each file into the SQL editor in filename order.
3. **Authentication → Sign In / Providers → Third-Party Auth → Add provider → Clerk** and enter your Clerk domain. This is the current official integration; JWT templates and sharing your JWT secret are not used.
4. Copy the project URL and the **publishable** key into `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. No service-role or secret key is needed anywhere: every server query runs as the signed-in user, and public pages call two narrowly scoped functions.
5. Realtime: the migration adds `transactions`, `shared_expenses`, `settlements` and `ledgers` to the `supabase_realtime` publication. Subscribers only receive rows their RLS policies allow.
6. Storage: the migration creates a private `attachments` bucket with member-only policies, ready for receipt uploads (see Limitations).

Optional sample data for a scratch database: `supabase/seed.sql` (instructions inside).

### 2. Clerk

1. Create an application at dashboard.clerk.com (email/password; add Google if you want social sign-in). Password reset comes with Clerk's sign-in flow.
2. Open **Connect with Supabase** (dashboard.clerk.com/setup/supabase). It adds the `role: "authenticated"` claim to session tokens, which Supabase needs.
3. Copy `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` into `.env.local`. For a quick local start without an account, `npx clerk@latest init` writes temporary development keys.
4. Paths are already set: `/sign-in`, `/sign-up`; account management lives at `/settings/account`.

### 3. App secrets

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | Base URL used in share and invitation links |
| `SHARE_LINK_SECRET` | 32 random bytes, base64. Encrypts share tokens so an owner can copy an active link again. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Rotating it makes existing links uncopyable (they keep working; create a new link to share again). |
| `E2E_USER_A_*`, `E2E_USER_B_*` | Two Clerk test users for the Playwright suite |

## Deploy to production (Vercel)

1. **Supabase (production project).** Create a separate project for production, so test data stays out. Pick the region closest to your users (Mumbai `ap-south-1` for India). Use a paid plan, because free projects pause when idle and have no daily backups. Apply every file in `supabase/migrations` in order; do not run `seed.sql`.
2. **Clerk (production instance).** In the Clerk app, create the production instance. It needs a domain you own (not `*.vercel.app`): add the DNS records Clerk shows. Then:
   - add the `role` and `email` claims to production session tokens (Clerk → Sessions → Customize session token: `{"role": "authenticated", "email": "{{user.primary_email_address}}"}`). `email` is the verified sign-in email; connect requests (a client accepting your request to link their Lekha account) are matched on it, and without it nobody sees requests sent to them;
   - set up Google sign-in with your own Google OAuth credentials if you use it (development instances use Clerk's shared ones).
3. **Connect them.** In the production Supabase project: Authentication → Third-Party Auth → add Clerk with the production Clerk domain (for example `clerk.yourdomain.com`).
4. **Vercel project.** Import the repository, framework Next.js, root directory `lekha` if the repo holds the parent folder. In Settings → Functions, set the region to match Supabase (for example `bom1` Mumbai for `ap-south-1`), which turns each database call into milliseconds.
5. **Environment variables (Production):**

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_APP_URL` | `https://yourdomain.com` (used in share and invite links) |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | the `pk_live_…` / `sk_live_…` keys |
   | `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-in` / `/sign-up` |
   | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from the production Supabase project |
   | `SHARE_LINK_SECRET` | a **new** 32-byte base64 secret, not the development one |

   Do not add the `E2E_*` variables or any Supabase secret/service-role key.
6. **Domain.** Add your domain in Vercel and point DNS at it. Use the same domain as `NEXT_PUBLIC_APP_URL`.
7. **Rate limits.** In Vercel → Firewall, add rate-limit rules for `/s/*`, `/api/share/*` and `/invite/*` (for example 60 requests per minute per IP). The built-in limiter only counts within one server instance.
8. **Check before announcing.** Run the end-to-end suite against a preview deployment that uses the Clerk development instance and a staging Supabase project: `E2E_BASE_URL=https://<preview-url> npm run test:e2e`.

Limits on Vercel: Excel imports are capped at 4 MB (Vercel rejects request bodies over 4.5 MB). PDF export reads `assets/fonts`, which is bundled into the export routes by `outputFileTracingIncludes`.

## Project layout

```
supabase/migrations/   schema, RLS + grants, audit triggers, RPCs (core, modules, sharing/import), function grants, realtime, storage
src/lib/domain/        pure, tested calculations: money (bigint paise), tax, ledger statements, split, advances, tax summary, dates
src/lib/import|export/ spreadsheet parsing, report tables → XLSX / CSV / PDF
src/lib/server/        auth context, queries (RLS-scoped), access, tokens, rate limit, shared-link loader
src/app/(app)/         signed-in screens and Server Functions (actions/)
src/app/s/[token]      public read-only statement · src/app/invite/[token] invitation landing
src/app/api/           exports, import preview/commit, public share endpoint
tests/                 unit, db (PGlite + RLS), e2e (Playwright), fixtures
```

## Assumptions

- The two original workbooks (`ramesh_saini_transaction_record.xlsx`, `RIshabh sales and creative transaction.xlsx`) were not in the project folder. The importer is built from the layouts described in the brief, and tests use generated workbooks with the same columns plus the usual mess (title rows, extra sheets, blank rows, Excel serial dates, DD/MM text dates, missing SR. NO., formula balance columns, total lines). Run your real files through **Import** to check; nothing is saved until you confirm.
- Workspaces and memberships live in Postgres, not Clerk Organizations. Contractors and friends need access to exactly one ledger, which a membership table plus ledger-scoped collaborator grants handles cleanly under RLS. Every new user gets their own workspace at onboarding and can create more.
- Indian defaults: INR, `en-IN` formatting, Asia/Kolkata calendar dates, FY from April. GST 18% / TDS 1% on taxable value are only starting values; every bill takes its own rates.
- A taxation-ledger "bill" is non-cash: it changes a party balance and the tax summary but not Money In/Out. Cash payments are separate entries. See [docs/ACCOUNTING.md](docs/ACCOUNTING.md).

## Limitations

- Attachments: the private bucket, policies and `attachments` table exist, but the upload UI is not built yet.
- Group shared accounts settle against each person's net position (simplified debts). Pairwise history between two specific people in a large group is not tracked separately.
- Ledger screens load every entry of a ledger to compute running balances. This is comfortable into the tens of thousands of rows; very large ledgers would want a server-side window function view.
- Lekha is a record-keeping tool. It does not file GST or TDS returns and is not a substitute for advice from a qualified accountant.
