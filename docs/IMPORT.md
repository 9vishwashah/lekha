# Importing your existing Excel sheets

Open a ledger → **Import**. Pick the .xlsx file (up to 4 MB, 10,000 rows per sheet). Nothing is saved until you press **Import N entries**, and then all rows are saved together or none are.

## Basic sheets (Ramesh Saini layout)

Columns: `SR. NO. · DATE · PAYEE (or NAME) · CREDIT · DEBIT`, optionally a running `BALANCE`.

1. Create a **Basic** ledger with the contractor linked. Leave the balance reading as **Cash book** to match the sheet.
2. If the sheet starts from a carried-forward figure, enter it as the ledger's **opening balance** (and date) rather than importing the "B/F" line.
3. Import. CREDIT becomes Money In, DEBIT becomes Money Out. SR. NO. gaps are fine: Lekha numbers entries itself (`BL-0001` …) in the sheet's order.
4. The BALANCE column is read only to recognise it; it is never imported. After import, compare Lekha's closing balance with the sheet's last balance. If they differ, the sheet had a manual slip or a missing row; the row list shows every skipped line.

## Taxation sheets (Rishabh Sales & Creative layout)

Columns: `DATE · NAME (or PAYEE) · CREDIT · DEBIT · BILL AMT · GST · TDS · AFTER TDS`.

1. Create a **Taxation** ledger. Choose **Party account** if you want "You owe *party*" balances; **Cash book** if you only want the cash view.
2. Rows with BILL AMT and no CREDIT/DEBIT become **bills** (no cash). Choose whether they are bills *from* the party (you owe) or *to* the party (they owe).
3. Rows with CREDIT or DEBIT become payments; if they also carry BILL AMT/GST/TDS, the tax breakdown is attached to that payment.
4. GST and TDS amounts are taken from the sheet. AFTER TDS is recalculated as `BILL AMT + GST − TDS`; if the sheet's figure differs, the row is flagged for a look and the calculated value is used.
5. Rows like "GST paid to Government" import as ordinary payments. If you want them in the tax summary as tax payments, void them after import and record them with **Add entry → Tax paid**.

## What the preview tells you

| Status | Meaning | Imported? |
| --- | --- | --- |
| Ready | Valid date and exactly one amount | Yes |
| Check | Valid, but looks the same as an earlier row, used a filled-in date, or the sheet's AFTER TDS disagrees | Yes |
| Can't import | Unreadable date, both credit and debit filled, negative or non-numeric amount, no amount | Only if you explicitly tick "import without these rows"; they're listed in the import record |
| Total line | TOTAL, B/F, C/F, closing/opening balance, or a row with only figures and no date or name | No (reported) |
| Blank | Empty row | No |

Dates: real Excel dates, Excel serial numbers, `DD/MM/YYYY`, `D/M/YY`, `DD-MM-YYYY`, `06-Apr-26`, `12 September 2026`, ISO `YYYY-MM-DD`. Day-first is assumed. Use **Use the previous row's date** for sheets that only write the date once per day.

## Safety

- The same sheet from the same file (SHA-256 of the file) can't be imported into the same ledger twice.
- Every imported entry records its batch and source row, and the batch keeps the file name, sheet, counts and the list of issues (shown under **Earlier imports**).
- Import never merges contractors or overwrites existing entries. To undo, void the imported entries (they are marked "import" in their detail and activity log).
