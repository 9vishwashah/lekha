# Accounting and permissions design

## Money

- Stored as `NUMERIC(14,2)`; always positive, with an explicit `direction` (`in` = credit / Money In, `out` = debit / Money Out). A row can never be both.
- In TypeScript all arithmetic uses `bigint` paise (`src/lib/domain/money.ts`). Rounding is half away from zero, identical to PostgreSQL `round()`. Floats only appear at the spreadsheet boundary, where they are snapped once.
- Totals, running balances and tax amounts are never stored or accepted from the browser. They are derived from entries every time (`buildStatement`, `taxSummary`, `participantBalances`), and the same functions feed screens, dashboard, reports, exports and the public page.

## Entries (`transactions`)

| Kind | Moves cash? (`is_cash`) | Changes party balance? (`affects_party`) | Created by |
| --- | --- | --- | --- |
| `regular` | yes | yes | entry form |
| `invoice` (bill) | no | yes | taxation entry form, import |
| `tax_settlement` | yes | **no** | "Tax paid" form |
| `advance_given` | yes | yes | advances |
| `advance_recovery` | yes | yes | advance cash recovery |
| `expense` | yes | yes | expense "paid from a ledger" |
| `reversal` | copies the original | copies the original | reverse action |

Status is `draft`, `posted` or `void`. Only posted rows count. Ordering is `(txn_date, seq)`; `seq` and the voucher number (`BL-0001`, `TX-0001`, `PS-…`) are allocated under a row lock on the ledger, so they are unique and gap-free per ledger.

### Balance perspectives

- **Cash book** (default, matches the supplied sheets): `closing = opening + cash in − cash out`. Bills and tax-only rows don't move it. A positive balance is cash on hand, never described as a debt.
- **Party account**: `closing = opening + out − in`, over every row that affects the party (payments, advances, bills, recoveries). Positive: "*Party* owes you". Negative: "You owe *party*". Tax payments to Government are excluded, so paying GST never reduces what you owe a contractor.

Dashboard and reports keep cash movement, receivables, payables, advances and expenses as separate figures. They are never added together.

### Corrections

- **Amend** (regular entries and bills): fields change in place; the audit log records every changed field with old and new values. Tax is recomputed by the database.
- **Void**: the row stays, struck through, excluded from all totals; a reason is required. Voiding an expense/advance/recovery entry voids its linked record too, in the same transaction.
- **Reverse**: posts an equal and opposite entry (`kind = reversal`, `reversal_of = original`). Both remain visible and net to zero. An entry can be reversed once; reversed entries can't be amended.

## Tax

```
gst   = round(taxable × gst_rate%)                    (0 when GST does not apply)
cgst  = round(gst / 2), sgst = gst − cgst            intra-state
igst  = gst                                          inter-state
gross = taxable + gst
tds   = round(base × tds_rate%), base = taxable | gross (chosen per bill)
net   = gross − tds
```

Workbook check: taxable ₹10,00,000, GST 18% = ₹1,80,000, TDS 1% on taxable = ₹10,000 → **₹11,70,000** after TDS.

- `app.compute_tax` (SQL) and `computeTax` (TypeScript) implement the same rules; a test asserts identical results.
- The database computes and stores the breakdown at posting time, with the rates used. Check constraints enforce `gst = cgst + sgst + igst`, `gross = taxable + gst`, `net = gross − tds`. Changing workspace defaults never touches posted bills.
- A bill's entry amount is its net after TDS. Imported bills keep the sheet's own GST/TDS amounts; effective rates are derived for display and the sheet's AFTER TDS is checked against the calculation.
- Tax payments ("GST paid to Government") are `tax_settlement` entries plus a `tax_settlements` row (tax type, period month, challan, status, account mapping: GST payable, GST input credit, TDS payable or other). Nothing assumes GST paid is claimable input credit.
- The monthly summary groups by invoice date (falls back to entry date) or entry date, excludes reversed bills, and shows GST paid against GST billed. It is a working summary, not a return.

## Advances

`outstanding = amount − cash recovered − amount adjusted against bills`

- An advance is a receivable, not an expense. Given from a ledger, it writes one `advance_given` Money Out entry.
- A cash recovery writes Money In (`advance_recovery`). An adjustment against a bill writes no entry: in a party ledger the bill and the advance already offset each other, so recording cash would double count.
- The advance row is locked while an allocation is recorded, and the database rejects any amount above the outstanding balance. Retried submissions are idempotent.
- Status: not recovered, partly recovered, recovered, adjusted against bill, void; overdue when past the expected date with money outstanding.

## Expenses

The expense row is the canonical record of spending. "Paid from a ledger" also writes exactly one `expense` entry in that ledger, linked by `transaction_id`, in the same database transaction. Editing the expense updates that entry; voiding it voids both. Expense reports read only `expenses`; cash reports read only `transactions`.

## Personal & shared accounts

**Everyone in a shared account is a client account.** Participants other than the owner point at a row in `contractors` (kind `personal` for friends and family, `business` for clients and contractors), so their balance appears on Home ("People owe you" / "You owe people") and on their client page next to any party ledgers with them. A new person can be added inline from the shared-account form. Renaming the client renames them in every shared account. Inviting them links their sign-in to that participant; their client record then shows "On Lekha", and their own Home includes what they owe or are owed in accounts others shared with them. Migration `20261029000800_people.sql` converts older free-text participants into clients (matching an existing client by name, otherwise creating a personal one) without changing any balance.


One canonical `shared_expenses` row per expense, with `shared_expense_payers` (who paid how much) and `shared_expense_shares` (each person's share). The database rejects a record unless payers and shares each add up exactly to the total (equal splits may differ by at most one paisa; percentages must add to 100).

```
net(person) = paid − own share + repayments made − repayments received
```

Nets always sum to zero across the ledger, so "Suraj owes Vishwa ₹50" and "Vishwa is owed ₹50" are the same figure with opposite signs.

**Perspective convention.** In viewer V's books, another participant P has a personal account. When V's payment covers P's share, P's account is debited (a receivable: "P owes you"). When P's payment covers V's share, it is credited (a payable: "You owe P"). The screens use "You paid", "Your share", "You lent", "You borrowed", "You owe", "Owed to you" and "Settled"; the debit/credit reading is in exports.

Shares are computed with largest-remainder rounding (leftover paise go to the largest fractional parts, ties to the earlier person). Repayments are `settlements`, never expenses; a repayment may not exceed what the payer owes or what the receiver is owed, checked under a ledger lock so concurrent repayments can't overpay together. Corrections void the original (kept in history, marked "corrected") and write a new record in one step.

## Tenancy and permissions

- Every business row carries `workspace_id`. Child tables use composite foreign keys `(parent_id, workspace_id)`, so a row can't point at another tenant's parent even through a crafted request.
- Identity is the Clerk user id from the session token (`auth.jwt()->>'sub'`), via Supabase's third-party auth. No service-role key exists in the app.
- RLS is enabled on every table. `anon` and `authenticated` start with no privileges; reads are granted table by table and filtered by policies. Financial tables have **no** direct insert/update/delete grants: writes go through `SECURITY DEFINER` functions that authorise first, validate, and run atomically. Contractor GSTIN/PAN are excluded from the column grant and served only to members who can write. Share token hashes are never readable.

| Role | Scope | Can |
| --- | --- | --- |
| Owner / Admin | workspace | everything; manage members and settings |
| Member | workspace | create and correct entries, ledgers, contractors, expenses, advances, sharing |
| Viewer | workspace | read only |
| Collaborator | one ledger | view; plus only what the invitation granted: add entries, edit own, edit any, see tax |
| Public link | one ledger | read-only statement with the fields the owner allowed |

- **Public links**: 32 random bytes, base64url. The database stores a SHA-256 hash for lookup and an AES-256-GCM ciphertext (key only on the app server) so the owner can copy the link again. `get_shared_ledger(token)` is the only thing anonymous visitors can execute; it returns no database ids, notes, attachments or workspace details. Revoke, rotate (old link dies instantly) and expiry are supported. Pages poll a version endpoint for live updates; routes are rate-limited, `noindex`, and `no-referrer`.
- **Invitations**: single-use, expire in 14 days (configurable 1–60), require a signed-in account to accept, and create a ledger-scoped collaborator (or a workspace member for workspace invitations). Collaborators cannot change their own permissions, see other ledgers, expenses, advances or the workspace, or delete history.
- **Audit**: triggers write `audit_logs` for every insert/update/delete on business tables with actor id and role (`owner`, `member`, `collaborator`, …) and a field-level diff. A trigger blocks updates and deletes on the log itself.
