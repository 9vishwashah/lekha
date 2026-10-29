"use client";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Download,
  FileSpreadsheet,
  FileText,
  History,
  Plus,
  Printer,
  Settings2,
  Share2,
  Upload,
} from "lucide-react";
import { Amount, Money } from "@/components/ui/amount";
import { Badge, walletOf } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { DateRangeInput } from "@/components/ui/date-picker";
import { EntryComposer, type TaxDefaults } from "./entry-composer";
import { EntryDetail } from "./entry-detail";
import { ShareSheet } from "./share-sheet";
import { LiveRefresh } from "./live-refresh";
import { KIND_LABEL } from "@/lib/domain/ledger";
import { toPaise } from "@/lib/domain/money";
import { formatDate, formatDateShort, relativeTime } from "@/lib/domain/dates";
import type { LedgerAccess } from "@/lib/server/access";
import type { TaxDetail, Txn } from "@/lib/types";
import { cn } from "@/lib/cn";

interface Line {
  txn: Txn;
  counted: boolean;
  running: string;
  reversed: boolean;
}

const TYPE_LABEL = { basic: "Basic ledger", taxation: "Taxation ledger" };

export function LedgerScreen({
  ledger,
  summary,
  lines,
  tax,
  names,
  access,
  userId,
  today,
  taxDefaults,
  filters,
  openAdd,
  hasFilters,
  visibleIn,
  visibleOut,
}: {
  ledger: {
    id: string;
    name: string;
    color: string;
    ledger_type: "basic" | "taxation";
    perspective: "cashbook" | "party";
    gst_mode: "intra" | "inter";
    status: "active" | "archived";
    partyName: string | null;
    contractorId: string | null;
    reference: string | null;
    openingDate: string | null;
  };
  summary: {
    opening: string;
    closing: string;
    moneyIn: string;
    moneyOut: string;
    billsIn: string;
    billsOut: string;
    meaning: string;
    hint: string;
    drafts: number;
    advanceOutstanding: string | null;
    lastActivity: string;
    totalEntries: number;
  };
  lines: Line[];
  tax: Record<string, TaxDetail>;
  names: Record<string, string>;
  access: LedgerAccess;
  userId: string;
  today: string;
  taxDefaults: TaxDefaults;
  filters: { q: string; dir: string; status: string; from: string; to: string };
  openAdd: boolean;
  hasFilters: boolean;
  visibleIn: string;
  visibleOut: string;
}) {
  const router = useRouter();
  const w = walletOf(ledger.color);
  const archivedAtLoad = ledger.status === "archived";
  const [composer, setComposer] = useState(openAdd && access.canCreate && !archivedAtLoad);
  const [editing, setEditing] = useState<Txn | null>(null);
  const [selected, setSelected] = useState<Line | null>(null);
  const [share, setShare] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const archived = ledger.status === "archived";
  const canAdd = access.canCreate && !archived;
  const [search, setSearch] = useState(filters.q);
  const [, startFilter] = useTransition();
  const applyFilters = useCallback(
    (patch: Partial<typeof filters>) => {
      const next = { ...filters, ...patch };
      const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v) as [string, string][]);
      startFilter(() => router.replace(`/ledgers/${ledger.id}${qs.size ? `?${qs}` : ""}`, { scroll: false }));
    },
    [filters, ledger.id, router],
  );
  // Search applies after a short pause in typing.
  useEffect(() => {
    if (search === filters.q) return;
    const t = setTimeout(() => applyFilters({ q: search.trim() }), 350);
    return () => clearTimeout(t);
  }, [search, filters.q, applyFilters]);

  // Opened from "Add something": drop ?add=1 so a refresh doesn't reopen the form.
  useEffect(() => {
    if (openAdd) router.replace(`/ledgers/${ledger.id}`, { scroll: false });
  }, [openAdd, router, ledger.id]);

  const closing = toPaise(summary.closing);
  const showAbs = ledger.perspective === "party";
  const canEditTxn = (t: Txn) => access.canEditAll || (access.canEditOwn && t.created_by === userId);
  const isTax = ledger.ledger_type === "taxation";

  // Newest first for reading; running balances were computed oldest first on the server.
  const ordered = useMemo(() => [...lines].reverse(), [lines]);
  const groups = useMemo(() => {
    const map = new Map<string, Line[]>();
    for (const l of ordered) map.set(l.txn.txn_date, [...(map.get(l.txn.txn_date) ?? []), l]);
    return [...map.entries()];
  }, [ordered]);

  const exportHref = (format: string) => {
    const qs = new URLSearchParams({ format });
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    return `/api/export/ledger/${ledger.id}?${qs}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print flex items-center justify-between">
        <Link href="/ledgers" className="inline-flex h-11 items-center gap-2 rounded-full pr-3 text-sm font-medium text-ink-2 hover:text-ink">
          <ArrowLeft className="size-4" /> Ledgers
        </Link>
        <LiveRefresh ledgerId={ledger.id} tables={["transactions", "ledgers"]} />
      </div>

      {/* Hero wallet */}
      <section className={cn("relative overflow-hidden rounded-[32px] p-6 sm:p-8", w.bg, w.fg)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={cn("text-sm font-medium", w.sub)}>
              {TYPE_LABEL[ledger.ledger_type]}
              {ledger.reference && ` · Ref ${ledger.reference}`}
            </div>
            <h1 className="display mt-1 text-[2.4rem] font-extrabold sm:text-6xl">{ledger.name}</h1>
            {ledger.partyName && (
              <Link href={access.kind === "member" && ledger.contractorId ? `/contractors/${ledger.contractorId}` : "#"} className={cn("mt-1 inline-block text-[15px] font-medium underline-offset-4 hover:underline", w.sub)}>
                with {ledger.partyName}
              </Link>
            )}
          </div>
          {archived && <Badge tone="ink">Archived</Badge>}
        </div>

        <div className="mt-10 flex flex-col gap-1">
          <span className={cn("text-[15px] font-semibold")}>{summary.meaning}</span>
          <Amount value={showAbs && closing < 0n ? -closing : closing} size="hero" className="block truncate" />
          <span className={cn("text-[13px]", w.sub)}>
            {summary.hint} · updated {relativeTime(summary.lastActivity)}
          </span>
        </div>

        <dl className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className={cn("text-[13px]", w.sub)}>Opening{filters.from ? ` on ${formatDate(filters.from)}` : ""}</dt>
            <dd>
              <Amount value={toPaise(summary.opening)} size="sm" />
            </dd>
          </div>
          <div>
            <dt className={cn("text-[13px]", w.sub)}>Money in</dt>
            <dd>
              <Amount value={toPaise(summary.moneyIn)} size="sm" />
            </dd>
          </div>
          <div>
            <dt className={cn("text-[13px]", w.sub)}>Money out</dt>
            <dd>
              <Amount value={toPaise(summary.moneyOut)} size="sm" />
            </dd>
          </div>
          {toPaise(summary.billsIn) + toPaise(summary.billsOut) > 0n ? (
            <div>
              <dt className={cn("text-[13px]", w.sub)}>Bills (no cash)</dt>
              <dd>
                <Amount value={toPaise(summary.billsIn) + toPaise(summary.billsOut)} size="sm" />
              </dd>
            </div>
          ) : summary.advanceOutstanding !== null ? (
            <div>
              <dt className={cn("text-[13px]", w.sub)}>Advance outstanding</dt>
              <dd>
                <Amount value={toPaise(summary.advanceOutstanding)} size="sm" />
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {/* Actions */}
      <div className="no-print -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&>*]:shrink-0">
        {canAdd && (
          <Button size="lg" onClick={() => { setEditing(null); setComposer(true); }}>
            <Plus className="size-5" /> Add entry
          </Button>
        )}
        {access.canManage && (
          <Button size="lg" variant="secondary" onClick={() => setShare(true)}>
            <Share2 className="size-4" /> Share
          </Button>
        )}
        <Button size="lg" variant="secondary" onClick={() => setExportOpen(true)}>
          <Download className="size-4" /> Export
        </Button>
        {access.canManage && (
          <>
            <Link href={`/ledgers/${ledger.id}/import`} className="inline-flex h-14 items-center gap-2 rounded-full px-5 text-[15px] font-medium hover:bg-sunken">
              <Upload className="size-4" /> Import
            </Link>
            <Link href={`/ledgers/${ledger.id}/activity`} className="inline-flex h-14 items-center gap-2 rounded-full px-5 text-[15px] font-medium hover:bg-sunken">
              <History className="size-4" /> Activity
            </Link>
            <Link href={`/ledgers/${ledger.id}/settings`} className="inline-flex h-14 items-center gap-2 rounded-full px-5 text-[15px] font-medium hover:bg-sunken">
              <Settings2 className="size-4" /> Settings
            </Link>
          </>
        )}
      </div>

      {access.kind === "collaborator" && (
        <p className="rounded-3xl bg-surface p-4 text-sm text-ink-2 ring-1 ring-inset ring-line">
          You were invited to this ledger.{" "}
          {access.canCreate ? "You can add entries" : "You can view entries"}
          {access.canEditAll ? " and change any entry." : access.canEditOwn ? " and change the ones you added." : "."} Every change is recorded with your name.
        </p>
      )}

      {/* Filters apply as you change them; the URL keeps them, so Back and sharing work. */}
      <div className="no-print flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <label className="sr-only" htmlFor="q">
          Search entries
        </label>
        <input
          id="q"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search description, payee, amount"
          className="h-11 min-w-0 rounded-full bg-surface px-4 text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink md:w-72"
        />
        <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
          <label className="sr-only" htmlFor="dir">
            Direction
          </label>
          <select
            id="dir"
            value={filters.dir}
            onChange={(e) => applyFilters({ dir: e.target.value })}
            className="h-11 rounded-full bg-surface px-4 text-sm ring-1 ring-inset ring-line"
          >
            <option value="">In and out</option>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
          <label className="sr-only" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            value={filters.status}
            onChange={(e) => applyFilters({ status: e.target.value })}
            className="h-11 rounded-full bg-surface px-4 text-sm ring-1 ring-inset ring-line"
          >
            <option value="">Any status</option>
            <option value="posted">Posted</option>
            <option value="draft">Draft</option>
            <option value="void">Void</option>
          </select>
          <DateRangeInput
            className="col-span-2"
            label="Any date"
            from={filters.from}
            to={filters.to}
            onChange={(r) => applyFilters({ from: r.from, to: r.to })}
          />
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              applyFilters({ q: "", dir: "", status: "", from: "", to: "" });
            }}
            className="inline-flex h-11 items-center justify-center rounded-full px-3 text-sm font-medium text-ink-2 hover:text-ink"
          >
            Clear filters
          </button>
        )}
      </div>

      {hasFilters && (
        <p className="text-sm text-ink-2">
          Showing {lines.length} of {summary.totalEntries} entries · <Money value={toPaise(visibleIn)} tone="in" /> in ·{" "}
          <Money value={toPaise(visibleOut)} tone="out" /> out. Balances still include every entry.
        </p>
      )}

      {/* Entries */}
      {lines.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border-2 border-dashed border-line p-8 text-center">
          <p className="display text-2xl font-bold">{hasFilters ? "Nothing matches these filters" : "No entries yet"}</p>
          <p className="mt-1 text-ink-2">
            {hasFilters ? "Clear the filters to see every entry." : canAdd ? "Add the first entry, or import your existing Excel sheet." : "Entries will appear here as they are added."}
          </p>
          {!hasFilters && canAdd && (
            <div className="mt-4 flex justify-center gap-2">
              <Button onClick={() => setComposer(true)}>
                <Plus className="size-4" /> Add entry
              </Button>
              {access.canManage && (
                <Link href={`/ledgers/${ledger.id}/import`} className="inline-flex h-12 items-center rounded-full px-5 font-medium ring-1 ring-inset ring-line">
                  Import Excel
                </Link>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Phones: cards grouped by day */}
          <div className="flex flex-col gap-5 md:hidden">
            {groups.map(([date, items]) => (
              <section key={date} aria-label={formatDate(date)}>
                <h3 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-ink-3">{formatDateShort(date, today)}</h3>
                <ul className="divide-y divide-line overflow-hidden rounded-[24px] bg-surface ring-1 ring-inset ring-line/70">
                  {items.map((l) => (
                    <li key={l.txn.id}>
                      <button type="button" onClick={() => setSelected(l)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-white">
                        <span
                          className={cn(
                            "inline-flex size-10 shrink-0 items-center justify-center rounded-full",
                            l.txn.direction === "in" ? "bg-[#d9eae5] text-in" : "bg-[#f6dcda] text-out",
                          )}
                          aria-hidden
                        >
                          {l.txn.direction === "in" ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate text-[15px] font-medium", l.txn.status === "void" && "line-through opacity-50")}>
                            {l.txn.description || l.txn.counterparty || KIND_LABEL[l.txn.kind]}
                          </span>
                          <span className="flex items-center gap-1.5 truncate text-[13px] text-ink-3">
                            {l.txn.voucher_no}
                            {l.txn.kind !== "regular" && ` · ${KIND_LABEL[l.txn.kind]}`}
                            {l.txn.status !== "posted" && <Badge tone={l.txn.status === "void" ? "neutral" : "warn"} className="h-5">{l.txn.status}</Badge>}
                            {l.reversed && <Badge className="h-5">reversed</Badge>}
                          </span>
                        </span>
                        <span className="text-right">
                          <Money
                            value={toPaise(l.txn.amount)}
                            tone={l.txn.direction === "in" ? "in" : "out"}
                            className={cn("block text-[15px] font-semibold", l.txn.status === "void" && "line-through opacity-50", !l.txn.is_cash && "opacity-75")}
                          />
                          {l.counted && <Money value={toPaise(l.running)} className="block text-[12px] text-ink-3" />}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {/* Larger screens: a proper ledger table */}
          <div className="hidden overflow-hidden rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70 md:block">
            <table className="w-full text-left text-[14px]">
              <caption className="sr-only">Entries in {ledger.name}, newest first</caption>
              <thead className="bg-ink text-[13px] text-surface">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">No.</th>
                  <th scope="col" className="px-3 py-3 font-medium">Date</th>
                  <th scope="col" className="px-3 py-3 font-medium">Payee / description</th>
                  {isTax && access.canViewTax && <th scope="col" className="px-3 py-3 text-right font-medium">Bill · GST · TDS</th>}
                  <th scope="col" className="px-3 py-3 text-right font-medium">Credit (in)</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Debit (out)</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {ordered.map((l) => {
                  const t = tax[l.txn.id];
                  const amount = toPaise(l.txn.amount);
                  return (
                    <tr
                      key={l.txn.id}
                      onClick={() => setSelected(l)}
                      className={cn("cursor-pointer hover:bg-white", l.txn.status !== "posted" && "text-ink-3")}
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-3">
                        <button type="button" className="underline-offset-2 hover:underline" onClick={() => setSelected(l)}>
                          {l.txn.voucher_no}
                        </button>
                      </td>
                      <td className="num whitespace-nowrap px-3 py-3">{formatDate(l.txn.txn_date)}</td>
                      <td className="max-w-[22rem] px-3 py-3">
                        <div className={cn("truncate font-medium", l.txn.status === "void" && "line-through")}>
                          {l.txn.counterparty || l.txn.description || KIND_LABEL[l.txn.kind]}
                        </div>
                        <div className="flex items-center gap-1.5 truncate text-[12px] text-ink-3">
                          {l.txn.counterparty && l.txn.description ? l.txn.description : ""}
                          {l.txn.kind !== "regular" && <Badge className="h-5">{KIND_LABEL[l.txn.kind]}</Badge>}
                          {l.txn.status !== "posted" && <Badge tone={l.txn.status === "void" ? "neutral" : "warn"} className="h-5">{l.txn.status}</Badge>}
                          {l.reversed && <Badge className="h-5">reversed</Badge>}
                          {l.txn.created_via === "collaborator" && <Badge tone="outline" className="h-5">by {names[l.txn.created_by] ?? "collaborator"}</Badge>}
                        </div>
                      </td>
                      {isTax && access.canViewTax && (
                        <td className="num whitespace-nowrap px-3 py-3 text-right text-[12px] text-ink-2">
                          {t ? (
                            <>
                              <div>
                                <Money value={toPaise(t.taxable_amount)} /> · <Money value={toPaise(t.gst_amount)} /> · <Money value={toPaise(t.tds_amount)} />
                              </div>
                              <div className="font-medium text-ink">
                                after TDS <Money value={toPaise(t.net_amount)} />
                              </div>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
                      <td className={cn("whitespace-nowrap px-3 py-3 text-right", l.txn.status === "void" && "line-through")}>
                        {l.txn.direction === "in" ? <Money value={amount} tone="in" className={cn("font-semibold", !l.txn.is_cash && "opacity-70")} /> : ""}
                      </td>
                      <td className={cn("whitespace-nowrap px-3 py-3 text-right", l.txn.status === "void" && "line-through")}>
                        {l.txn.direction === "out" ? <Money value={amount} tone="out" className={cn("font-semibold", !l.txn.is_cash && "opacity-70")} /> : ""}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        {l.counted ? <Money value={toPaise(l.running)} className="font-medium" /> : <span className="text-[12px] text-ink-3">not counted</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {summary.drafts > 0 && <p className="text-sm text-ink-3">{summary.drafts} draft entries are listed but not counted in balances.</p>}
        </>
      )}

      <EntryComposer
        key={editing?.id ?? "new"}
        open={composer}
        onClose={() => {
          setComposer(false);
          setEditing(null);
        }}
        ledger={{ id: ledger.id, ledger_type: ledger.ledger_type, perspective: ledger.perspective, gst_mode: ledger.gst_mode, partyName: ledger.partyName }}
        today={today}
        taxDefaults={taxDefaults}
        canTax={access.canViewTax}
        canSettleTax={access.kind === "member"}
        editing={editing}
        editingTax={editing ? (tax[editing.id] ?? null) : null}
      />
      <EntryDetail
        txn={selected?.txn ?? null}
        tax={selected ? (tax[selected.txn.id] ?? null) : null}
        names={names}
        reversed={selected?.reversed ?? false}
        canEdit={selected ? canEditTxn(selected.txn) && !archived : false}
        today={today}
        ledgerId={ledger.id}
        onClose={() => setSelected(null)}
        onEdit={() => {
          setEditing(selected!.txn);
          setSelected(null);
          setComposer(true);
        }}
      />
      {access.canManage && (
        <ShareSheet open={share} onClose={() => setShare(false)} ledgerId={ledger.id} ledgerName={ledger.name} taxation={isTax} />
      )}
      <Sheet open={exportOpen} onClose={() => setExportOpen(false)} title="Export statement" description={filters.from || filters.to ? "Uses the date range you filtered by." : "All entries in this ledger."}>
        <div className="grid gap-2 pb-2">
          {[
            { f: "pdf", label: "PDF statement", hint: "For sending or printing", icon: FileText },
            { f: "xlsx", label: "Excel workbook", hint: "With totals and Indian number format", icon: FileSpreadsheet },
            { f: "csv", label: "CSV", hint: "For other accounting software", icon: FileSpreadsheet },
          ].map(({ f, label, hint, icon: Icon }) => (
            <a key={f} href={exportHref(f)} className="flex items-center gap-4 rounded-3xl bg-white p-4 ring-1 ring-inset ring-line hover:bg-canvas">
              <Icon className="size-5" />
              <span>
                <span className="block font-semibold">{label}</span>
                <span className="block text-sm text-ink-2">{hint}</span>
              </span>
            </a>
          ))}
          <button type="button" onClick={() => { setExportOpen(false); setTimeout(() => window.print(), 300); }} className="flex items-center gap-4 rounded-3xl bg-white p-4 text-left ring-1 ring-inset ring-line hover:bg-canvas">
            <Printer className="size-5" />
            <span>
              <span className="block font-semibold">Print</span>
              <span className="block text-sm text-ink-2">Print this page as shown</span>
            </span>
          </button>
        </div>
      </Sheet>
    </div>
  );
}
