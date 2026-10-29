"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Checkbox, Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { amendEntry, postEntry, recordTaxPayment } from "@/app/(app)/actions/ledgers";
import { computeTax, explainTax } from "@/lib/domain/tax";
import { formatINR, tryPaise } from "@/lib/domain/money";
import { PAYMENT_MODES, type TaxDetail, type Txn } from "@/lib/types";
import { cn } from "@/lib/cn";

type Mode = "payment" | "bill" | "tax";

export interface ComposerLedger {
  id: string;
  ledger_type: "basic" | "taxation";
  perspective: "cashbook" | "party";
  gst_mode: "intra" | "inter";
  partyName: string | null;
}

export interface TaxDefaults {
  gstRate: string;
  tdsRate: string;
  tdsBase: "taxable" | "gross";
}

/** The last 24 months, newest first, as YYYY-MM. */
function recentMonths(today: string) {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m] = today.split("-").map(Number);
  return Array.from({ length: 24 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return { value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, label: `${names[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
  });
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Fast daily entry. Defaults to today and Money Out (the common case), puts the amount first,
 * and keeps optional fields folded away. Tax fields appear only in taxation ledgers.
 */
export function EntryComposer({
  open,
  onClose,
  ledger,
  today,
  taxDefaults,
  canTax,
  canSettleTax,
  editing,
  editingTax,
}: {
  open: boolean;
  onClose: () => void;
  ledger: ComposerLedger;
  today: string;
  taxDefaults: TaxDefaults;
  canTax: boolean;
  canSettleTax: boolean;
  editing?: Txn | null;
  editingTax?: TaxDetail | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const taxation = ledger.ledger_type === "taxation" && canTax;
  // The parent remounts this component (key) when a different entry is edited, so initial
  // state comes straight from the entry being edited.
  const t0 = editingTax ?? null;
  const [mode, setMode] = useState<Mode>(editing?.kind === "invoice" ? "bill" : "payment");
  const [direction, setDirection] = useState<"in" | "out">(editing?.direction ?? "out");
  const [amount, setAmount] = useState(editing?.amount ?? "");
  const [date, setDate] = useState(editing?.txn_date ?? today);
  const [description, setDescription] = useState(editing?.description ?? "");
  const [counterparty, setCounterparty] = useState(editing?.counterparty ?? "");
  const [paymentMode, setPaymentMode] = useState<string>(editing?.payment_mode ?? "");
  const [reference, setReference] = useState(editing?.reference_no ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [draft, setDraft] = useState(editing?.status === "draft");
  const [more, setMore] = useState(Boolean(editing?.payment_mode || editing?.reference_no || editing?.notes));
  const [withBill, setWithBill] = useState(Boolean(t0) && editing?.kind === "regular");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);

  // Tax inputs
  const [taxable, setTaxable] = useState(t0?.taxable_amount ?? "");
  const [gstOn, setGstOn] = useState(t0 ? t0.gst_applicable : true);
  const [gstType, setGstType] = useState<"intra" | "inter">(t0 ? (t0.gst_type === "inter" ? "inter" : "intra") : ledger.gst_mode);
  const [gstRate, setGstRate] = useState(t0 ? String(Number(t0.gst_rate)) : taxDefaults.gstRate);
  const [tdsOn, setTdsOn] = useState(t0 ? t0.tds_applicable : true);
  const [tdsRate, setTdsRate] = useState(t0 ? String(Number(t0.tds_rate)) : taxDefaults.tdsRate);
  const [tdsBase, setTdsBase] = useState<"taxable" | "gross">(t0?.tds_base ?? taxDefaults.tdsBase);
  const [tdsSection, setTdsSection] = useState(t0?.tds_section ?? "");
  const [invoiceNo, setInvoiceNo] = useState(t0?.invoice_no ?? "");
  const [invoiceDate, setInvoiceDate] = useState(t0?.invoice_date ?? "");
  // Tax payment inputs
  const [taxType, setTaxType] = useState<"gst" | "tds" | "other">("gst");
  const [periodMonth, setPeriodMonth] = useState(today.slice(0, 7));
  const [mapping, setMapping] = useState("gst_payable");

  const tax = useMemo(() => {
    const t = tryPaise(taxable);
    if (t === null || t <= 0n) return null;
    try {
      return computeTax({ taxable: t, gstApplicable: gstOn, gstType, gstRate: gstRate || "0", tdsApplicable: tdsOn, tdsRate: tdsRate || "0", tdsBase });
    } catch {
      return null;
    }
  }, [taxable, gstOn, gstType, gstRate, tdsOn, tdsRate, tdsBase]);

  const showTax = taxation && (mode === "bill" || (mode === "payment" && withBill));

  const reset = (keepDate = true) => {
    setAmount("");
    setDescription("");
    setCounterparty("");
    setReference("");
    setNotes("");
    setTaxable("");
    setInvoiceNo("");
    setInvoiceDate("");
    setTdsSection("");
    setWithBill(false);
    setDraft(false);
    if (!keepDate) setDate(today);
    setKey(newKey());
  };

  const taxPayload = () => ({
    taxable_amount: taxable.replace(/,/g, ""),
    gst_applicable: gstOn,
    gst_type: gstType,
    gst_rate: gstOn ? gstRate : "",
    tds_applicable: tdsOn,
    tds_rate: tdsOn ? tdsRate : "",
    tds_base: tdsBase,
    tds_section: tdsSection,
    invoice_no: invoiceNo,
    invoice_date: invoiceDate,
  });

  const submit = (another: boolean) => {
    setErrors({});
    setFormError(null);
    start(async () => {
      let result;
      if (mode === "tax") {
        result = await recordTaxPayment({
          ledger_id: ledger.id,
          txn_date: date,
          tax_type: taxType,
          amount,
          period_month: `${periodMonth}-01`,
          challan_no: reference,
          account_mapping: mapping as "gst_payable",
          payment_mode: paymentMode as "cash",
          description,
          idempotency_key: key,
        });
      } else {
        const payload = {
          kind: (mode === "bill" ? "invoice" : "regular") as "invoice" | "regular",
          direction,
          amount: mode === "bill" ? undefined : amount,
          txn_date: date,
          description,
          counterparty,
          payment_mode: paymentMode as "cash",
          reference_no: reference,
          notes,
          status: (draft ? "draft" : "posted") as "draft" | "posted",
          tax: showTax ? taxPayload() : undefined,
        };
        result = editing
          ? await amendEntry(editing.id, ledger.id, {
              ...payload,
              kind: undefined,
              status: editing.status === "draft" ? payload.status : undefined,
              // Unticking "attach bill details" on a payment removes its tax row.
              tax: showTax ? taxPayload() : taxation && editingTax ? null : undefined,
            })
          : await postEntry({ ...payload, ledger_id: ledger.id, idempotency_key: key });
      }
      if (!result.ok) {
        setFormError(result.error);
        setErrors(result.fieldErrors ?? {});
        return;
      }
      toast.success(result.message ?? "Saved");
      router.refresh();
      reset(true);
      if (!another || editing) onClose();
    });
  };

  const inLabel = mode === "bill" ? "Bill to party" : "Money in";
  const outLabel = mode === "bill" ? "Bill from party" : "Money out";

  return (
    <Sheet
      open={open}
      onClose={() => {
        setErrors({});
        setFormError(null);
        onClose();
      }}
      title={editing ? `Edit ${editing.voucher_no}` : "New entry"}
      description={ledger.partyName ? `With ${ledger.partyName}` : undefined}
      footer={
        <div className="flex gap-2">
          {!editing && (
            <Button variant="secondary" size="lg" className="flex-1" disabled={pending} onClick={() => submit(true)}>
              Save & add another
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={pending} onClick={() => submit(false)}>
            {pending ? "Saving…" : editing ? "Save changes" : "Save entry"}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-5 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        {taxation && !editing && (
          <Segmented
            label="Entry type"
            value={mode}
            onChange={setMode}
            options={[
              { value: "payment", label: "Payment" },
              { value: "bill", label: "Bill" },
              ...(canSettleTax ? [{ value: "tax" as const, label: "Tax paid" }] : []),
            ]}
          />
        )}

        {mode !== "tax" && (
          <Segmented
            label="Direction"
            size="lg"
            value={direction}
            onChange={setDirection}
            options={[
              { value: "in", label: inLabel, tone: "in" },
              { value: "out", label: outLabel, tone: "out" },
            ]}
          />
        )}
        {mode === "bill" && (
          <p className="-mt-2 text-[13px] text-ink-3">
            {direction === "out"
              ? "A bill the party raised on you. Recorded without moving cash; it increases what you owe them."
              : "A bill you raised on the party. Recorded without moving cash; it increases what they owe you."}
          </p>
        )}

        {mode !== "bill" && (
          <Field label={mode === "tax" ? "Amount paid to Government" : "Amount"} error={errors.amount}>
            {(p) => (
              <MoneyInput {...p} big value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus={!editing} required />
            )}
          </Field>
        )}

        {showTax && (
          <section aria-label="Tax details" className="flex flex-col gap-4 rounded-[24px] bg-lavender/25 p-4 ring-1 ring-inset ring-lavender/60">
            {mode === "payment" && <p className="text-[13px] text-ink-2">Bill details attached to this payment.</p>}
            <Field label="Taxable bill amount" error={errors["tax.taxable_amount"]}>
              {(p) => <MoneyInput {...p} big={mode === "bill"} value={taxable} onChange={(e) => setTaxable(e.target.value)} placeholder="0" autoFocus={mode === "bill"} />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Checkbox label="GST applies" checked={gstOn} onChange={(e) => setGstOn(e.target.checked)} />
              <Checkbox label="TDS withheld" checked={tdsOn} onChange={(e) => setTdsOn(e.target.checked)} />
            </div>
            {gstOn && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="GST rate %" error={errors["tax.gst_rate"]}>
                  {(p) => <Input {...p} inputMode="decimal" value={gstRate} onChange={(e) => setGstRate(e.target.value)} />}
                </Field>
                <Field label="GST type">
                  {(p) => (
                    <Select {...p} value={gstType} onChange={(e) => setGstType(e.target.value as "intra")}>
                      <option value="intra">CGST+SGST</option>
                      <option value="inter">IGST</option>
                    </Select>
                  )}
                </Field>
              </div>
            )}
            {tdsOn && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="TDS rate %" error={errors["tax.tds_rate"]}>
                  {(p) => <Input {...p} inputMode="decimal" value={tdsRate} onChange={(e) => setTdsRate(e.target.value)} />}
                </Field>
                <Field label="TDS on">
                  {(p) => (
                    <Select {...p} value={tdsBase} onChange={(e) => setTdsBase(e.target.value as "taxable")}>
                      <option value="taxable">Taxable</option>
                      <option value="gross">With GST</option>
                    </Select>
                  )}
                </Field>
                <Field label="TDS section" optional className="col-span-2">
                  {(p) => <Input {...p} value={tdsSection} onChange={(e) => setTdsSection(e.target.value)} placeholder="194C" maxLength={20} />}
                </Field>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Invoice no." optional>
                {(p) => <Input {...p} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} />}
              </Field>
              <Field label="Invoice date" optional>
                {(p) => <DateInput {...p} value={invoiceDate} onChange={setInvoiceDate} />}
              </Field>
            </div>
            {tax ? (
              <div className="rounded-2xl bg-surface p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-ink-2">After TDS</span>
                  <span className="num display text-3xl font-bold">{formatINR(tax.net)}</span>
                </div>
                <ul className="mt-2 space-y-1 text-[13px] text-ink-2">
                  {explainTax(tax, (v) => formatINR(v)).map((line) => (
                    <li key={line} className="num">
                      {line}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[12px] text-ink-3">The rates you enter are saved with this bill and never change later.</p>
              </div>
            ) : (
              <p className="text-[13px] text-ink-3">Enter the taxable amount to see GST, TDS and the amount after TDS.</p>
            )}
          </section>
        )}

        {mode === "tax" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tax">
              {(p) => (
                <Select
                  {...p}
                  value={taxType}
                  onChange={(e) => {
                    const v = e.target.value as "gst";
                    setTaxType(v);
                    setMapping(v === "gst" ? "gst_payable" : v === "tds" ? "tds_payable" : "other");
                  }}
                >
                  <option value="gst">GST</option>
                  <option value="tds">TDS</option>
                  <option value="other">Other</option>
                </Select>
              )}
            </Field>
            <Field label="For month">
              {(p) => (
                <Select {...p} value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)}>
                  {recentMonths(today).map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Account" className="col-span-2" hint="Where this payment is booked. GST paid is not assumed to be claimable input credit.">
              {(p) => (
                <Select {...p} value={mapping} onChange={(e) => setMapping(e.target.value)}>
                  <option value="gst_payable">GST payable (output tax settled)</option>
                  <option value="gst_input_credit">GST input credit</option>
                  <option value="tds_payable">TDS payable</option>
                  <option value="other">Other</option>
                </Select>
              )}
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" error={errors.txn_date}>
            {(p) => <DateInput {...p} value={date} onChange={setDate} required />}
          </Field>
          {mode !== "tax" ? (
            <Field label="Payee / name" optional>
              {(p) => <Input {...p} value={counterparty} onChange={(e) => setCounterparty(e.target.value)} maxLength={160} placeholder={ledger.partyName ?? ""} />}
            </Field>
          ) : (
            <Field label="Challan no." optional>
              {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />}
            </Field>
          )}
        </div>

        <Field label="Description" optional>
          {(p) => (
            <Input
              {...p}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              placeholder={mode === "tax" ? "GST paid to Government" : "Cement, labour, site visit…"}
            />
          )}
        </Field>

        {mode === "payment" && taxation && !editing && (
          <Checkbox label="Attach bill details (GST / TDS)" checked={withBill} onChange={(e) => setWithBill(e.target.checked)} />
        )}

        <button
          type="button"
          onClick={() => setMore(!more)}
          aria-expanded={more}
          className="flex h-11 items-center gap-2 self-start rounded-full px-1 text-sm font-medium text-ink-2"
        >
          <ChevronDown className={cn("size-4 transition-transform", more && "rotate-180")} />
          {more ? "Fewer details" : "Payment mode, reference, notes"}
        </button>
        {more && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Payment mode" optional>
                {(p) => (
                  <Select {...p} value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
                    <option value="">Not set</option>
                    {PAYMENT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {mode !== "tax" && (
                <Field label="Reference / receipt no." optional>
                  {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />}
                </Field>
              )}
            </div>
            {mode !== "tax" && (
              <Field label="Private notes" optional hint="Only people in your workspace see notes. Never shown on share links.">
                {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}
              </Field>
            )}
            {mode !== "tax" && (!editing || editing.status === "draft") && (
              <Checkbox
                label="Save as draft"
                hint="Drafts are listed but not counted in balances until posted."
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
              />
            )}
          </div>
        )}

        {formError && (
          <p role="alert" className="rounded-2xl bg-[#f6dcda] p-4 text-[15px] font-medium text-out">
            {formError}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
