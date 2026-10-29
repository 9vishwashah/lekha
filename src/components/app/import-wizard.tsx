"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/bits";
import { Checkbox, Select } from "@/components/ui/field";
import { Money } from "@/components/ui/amount";
import {
  FIELDS,
  FIELD_LABEL,
  type Field,
  type Grid,
  type Mapping,
  type ParsedRow,
  parseRows,
  summarise,
  toImportRows,
} from "@/lib/import/parse";
import { formatDate } from "@/lib/domain/dates";
import { tryPaise } from "@/lib/domain/money";
import { cn } from "@/lib/cn";

interface SheetPreview {
  name: string;
  grid: Grid;
  truncated: boolean;
  headerRow: number;
  mapping: Mapping;
  confidence: number;
  layout: "basic" | "taxation";
}

const colName = (i: number) => {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

const STATUS_TONE: Record<string, "in" | "warn" | "out" | "neutral"> = { ok: "in", warning: "warn", invalid: "out", summary: "neutral", blank: "neutral" };
const STATUS_LABEL: Record<string, string> = { ok: "Ready", warning: "Check", invalid: "Can't import", summary: "Total line", blank: "Blank" };

export function ImportWizard({ ledgerId, ledgerType }: { ledgerId: string; ledgerType: "basic" | "taxation" }) {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; hash: string; sheets: SheetPreview[] } | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [headerRow, setHeaderRow] = useState(0);
  const [fillDates, setFillDates] = useState(false);
  const [billDirection, setBillDirection] = useState<"in" | "out">("out");
  const [showOnly, setShowOnly] = useState<"all" | "issues">("issues");
  const [acknowledged, setAcknowledged] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sheet = file?.sheets[sheetIndex];

  const upload = async (f: File) => {
    setError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", f);
      const res = await fetch("/api/import/preview", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setFile({ name: json.fileName, hash: json.fileHash, sheets: json.sheets });
      const best = (json.sheets as SheetPreview[]).reduce((bi, s, i, arr) => (s.confidence > arr[bi].confidence ? i : bi), 0);
      chooseSheet(json.sheets, best);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const chooseSheet = (sheets: SheetPreview[], i: number) => {
    setSheetIndex(i);
    setMapping(sheets[i].mapping);
    setHeaderRow(Math.max(sheets[i].headerRow, 0));
    setAcknowledged(false);
  };

  const rows: ParsedRow[] = useMemo(
    () => (sheet ? parseRows(sheet.grid, headerRow, mapping, { fillMissingDates: fillDates, billDirection }) : []),
    [sheet, headerRow, mapping, fillDates, billDirection],
  );
  const counts = summarise(rows);
  const visible = showOnly === "issues" ? rows.filter((r) => r.status !== "ok" && r.status !== "blank") : rows.filter((r) => r.status !== "blank");
  const headerCells = sheet?.grid[headerRow] ?? [];
  const width = Math.max(...(sheet?.grid.slice(0, 50).map((r) => r.length) ?? [0]), 0);
  const hasTaxColumns = mapping.bill !== undefined;
  const mappingProblem =
    mapping.date === undefined
      ? "Choose which column holds the date"
      : mapping.credit === undefined && mapping.debit === undefined && mapping.bill === undefined
        ? "Choose at least a credit, debit or bill amount column"
        : hasTaxColumns && ledgerType !== "taxation"
          ? "Bill/GST/TDS columns need a taxation ledger. Unmap them or import into a taxation ledger."
          : null;

  const commit = async () => {
    if (!file || !sheet) return;
    setCommitting(true);
    setError(null);
    try {
      const payloadRows = toImportRows(rows);
      const res = await fetch("/api/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ledger_id: ledgerId,
          file_name: file.name,
          file_hash: file.hash,
          sheet_name: sheet.name,
          skipped_count: counts.invalid + counts.summary,
          issues: rows.filter((r) => r.messages.length).map((r) => ({ row: r.row, status: r.status, messages: r.messages.slice(0, 5) })),
          rows: payloadRows,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      toast.success(`${json.imported} entries imported`);
      router.push(`/ledgers/${ledgerId}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  };

  if (!file) {
    return (
      <Card className="flex flex-col items-start gap-4">
        <label
          htmlFor="import-file"
          className={cn(
            "flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-[24px] border-2 border-dashed border-line bg-canvas p-10 text-center hover:bg-sunken",
            uploading && "pointer-events-none opacity-60",
          )}
        >
          <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-mustard">
            <FileSpreadsheet className="size-6" />
          </span>
          <span className="display text-2xl font-bold">{uploading ? "Reading workbook…" : "Choose an Excel file"}</span>
          <span className="text-sm text-ink-2">.xlsx up to 4 MB. Nothing is saved until you confirm.</span>
          <input
            id="import-file"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </label>
        {error && (
          <p role="alert" className="font-medium text-out">
            {error}
          </p>
        )}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Sheet picker */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm text-ink-2">{file.name}:</span>
        {file.sheets.map((s, i) => (
          <button
            key={s.name}
            type="button"
            onClick={() => chooseSheet(file.sheets, i)}
            aria-pressed={i === sheetIndex}
            className={cn("h-10 rounded-full px-4 text-sm font-medium", i === sheetIndex ? "bg-ink text-surface" : "bg-surface ring-1 ring-inset ring-line")}
          >
            {s.name}
            <span className="ml-1.5 opacity-60">{s.grid.length} rows</span>
          </button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setFile(null)}>
          <Upload className="size-4" /> Different file
        </Button>
      </div>
      {sheet?.truncated && <p className="text-sm font-medium text-out">This sheet has more than 10,000 rows. Only the first 10,000 were read; split it and import the rest separately.</p>}

      {/* Mapping */}
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="display text-2xl font-bold">Match the columns</h2>
            <p className="text-sm text-ink-2">We guessed from the header row. Fix anything that looks wrong.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            Header is row
            <select
              value={headerRow}
              onChange={(e) => setHeaderRow(Number(e.target.value))}
              className="h-10 rounded-full bg-white px-3 ring-1 ring-inset ring-line"
            >
              {sheet!.grid.slice(0, 30).map((_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FIELDS.filter((f) => ledgerType === "taxation" || !["bill", "gst", "tds", "after_tds"].includes(f)).map((field: Field) => (
            <label key={field} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink-2">{FIELD_LABEL[field]}</span>
              <Select
                value={mapping[field] ?? ""}
                onChange={(e) => setMapping({ ...mapping, [field]: e.target.value === "" ? undefined : Number(e.target.value) })}
              >
                <option value="">Not in this sheet</option>
                {Array.from({ length: width }, (_, i) => (
                  <option key={i} value={i}>
                    {colName(i)}
                    {headerCells[i] !== null && headerCells[i] !== undefined ? ` · ${String(headerCells[i]).slice(0, 24)}` : ""}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-6">
          <Checkbox label="Use the previous row's date when a date is empty" checked={fillDates} onChange={(e) => setFillDates(e.target.checked)} />
          {ledgerType === "taxation" && (
            <label className="flex items-center gap-2 py-2 text-sm">
              Bills without a credit or debit are
              <select value={billDirection} onChange={(e) => setBillDirection(e.target.value as "in")} className="h-10 rounded-full bg-white px-3 ring-1 ring-inset ring-line">
                <option value="out">bills from the party</option>
                <option value="in">bills to the party</option>
              </select>
            </label>
          )}
        </div>
        {mappingProblem && <p className="font-medium text-out">{mappingProblem}</p>}
      </Card>

      {/* Summary */}
      {!mappingProblem && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="Import summary">
            {[
              { label: "Ready", value: counts.ok, cls: "bg-tea text-seashell" },
              { label: "Need a look", value: counts.warning, cls: "bg-mustard" },
              { label: "Can't import", value: counts.invalid, cls: "bg-red text-white" },
              { label: "Total lines skipped", value: counts.summary, cls: "bg-sky" },
              { label: "Blank rows", value: counts.blank, cls: "bg-sunken" },
            ].map((s) => (
              <div key={s.label} className={cn("rounded-[22px] p-4", s.cls)}>
                <div className="display text-4xl font-extrabold">{s.value}</div>
                <div className="text-sm font-medium opacity-80">{s.label}</div>
              </div>
            ))}
          </section>
          <p className="text-[15px] text-ink-2">
            {counts.importable} entries will be imported: <Money value={counts.credits} tone="in" /> credit and <Money value={counts.debits} tone="out" /> debit.
          </p>

          <div className="flex items-center gap-2">
            <button type="button" aria-pressed={showOnly === "issues"} onClick={() => setShowOnly("issues")} className={cn("h-10 rounded-full px-4 text-sm font-medium", showOnly === "issues" ? "bg-ink text-surface" : "bg-surface ring-1 ring-inset ring-line")}>
              Rows to check
            </button>
            <button type="button" aria-pressed={showOnly === "all"} onClick={() => setShowOnly("all")} className={cn("h-10 rounded-full px-4 text-sm font-medium", showOnly === "all" ? "bg-ink text-surface" : "bg-surface ring-1 ring-inset ring-line")}>
              All rows
            </button>
          </div>

          <div className="overflow-x-auto rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Rows found in the sheet</caption>
              <thead className="bg-ink text-surface">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium">Row</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Payee</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Credit</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Debit</th>
                  {ledgerType === "taxation" && <th scope="col" className="px-3 py-2.5 text-right font-medium">Bill · GST · TDS</th>}
                  <th scope="col" className="px-3 py-2.5 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visible.slice(0, 500).map((r) => (
                  <tr key={r.row} className={r.status === "invalid" ? "bg-[#fbeceb]" : r.status === "summary" ? "text-ink-3" : ""}>
                    <td className="num px-3 py-2">{r.row}</td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    </td>
                    <td className="num whitespace-nowrap px-3 py-2">{r.date ? formatDate(r.date) : "—"}</td>
                    <td className="max-w-48 truncate px-3 py-2">{r.payee ?? ""}</td>
                    <td className="px-3 py-2 text-right">{r.direction === "in" && r.amount ? <Money value={tryPaise(r.amount)!} tone="in" /> : ""}</td>
                    <td className="px-3 py-2 text-right">{r.direction === "out" && r.amount ? <Money value={tryPaise(r.amount)!} tone="out" /> : ""}</td>
                    {ledgerType === "taxation" && (
                      <td className="num whitespace-nowrap px-3 py-2 text-right text-[12px]">
                        {r.tax ? `${r.tax.taxable_amount} · ${r.tax.gst_amount} · ${r.tax.tds_amount}` : ""}
                      </td>
                    )}
                    <td className="px-3 py-2 text-[13px] text-ink-2">{r.messages.join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length > 500 && <p className="p-3 text-sm text-ink-3">Showing the first 500 of {visible.length} rows.</p>}
            {visible.length === 0 && <p className="p-5 text-ink-2">No problems found. Every row with an amount is ready.</p>}
          </div>

          <Card className="flex flex-col gap-4">
            {counts.invalid > 0 && (
              <Checkbox
                label={`Import without the ${counts.invalid} rows that can't be imported`}
                hint="They are listed in the import record so you can add them by hand. Fix the sheet and upload again if you'd rather keep them."
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
            )}
            {error && (
              <p role="alert" className="rounded-2xl bg-[#f6dcda] p-4 font-medium text-out">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="lg" disabled={committing || counts.importable === 0 || (counts.invalid > 0 && !acknowledged)} onClick={commit}>
                {committing ? "Importing…" : `Import ${counts.importable} entries`}
              </Button>
              <Link href={`/ledgers/${ledgerId}`} className="inline-flex h-14 items-center rounded-full px-5 font-medium hover:bg-sunken">
                Cancel
              </Link>
            </div>
            <p className="text-[13px] text-ink-3">All rows are saved together or not at all. Importing the same sheet from the same file twice is blocked.</p>
          </Card>
        </>
      )}
    </div>
  );
}
