"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import type { WalletOption } from "./wallet-select";
import { DateInput } from "@/components/ui/date-picker";
import { Badge } from "@/components/ui/bits";
import { Amount } from "@/components/ui/amount";
import { classifyEntry, deleteEntry, reverseEntry } from "@/app/(app)/actions/ledgers";
import { deleteTransfer } from "@/app/(app)/actions/entries";
import { KIND_LABEL } from "@/lib/domain/ledger";
import { toPaise, formatINR } from "@/lib/domain/money";
import { formatDate, formatDateTime } from "@/lib/domain/dates";
import { formatRate } from "@/lib/domain/tax";
import { toRateMilli } from "@/lib/domain/money";
import { NATURES, paymentModeLabel, type TaxDetail, type Txn } from "@/lib/types";

/** Full detail of one entry, with the correction actions this user is allowed to take. */
export function EntryDetail({
  txn,
  tax,
  names,
  onClose,
  onEdit,
  canEdit,
  wallets,
  canClassify,
  perspective,
  reversed,
  today,
  ledgerId,
}: {
  txn: Txn | null;
  tax: TaxDetail | null;
  names: Record<string, string>;
  onClose: () => void;
  onEdit: () => void;
  canEdit: boolean;
  wallets: WalletOption[];
  canClassify: boolean;
  perspective: string;
  reversed: boolean;
  today: string;
  ledgerId: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"view" | "void" | "reverse">("view");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const close = () => {
    setStep("view");
    setReason("");
    setError(null);
    onClose();
  };

  if (!txn) return <Sheet open={false} onClose={close} title="">{null}</Sheet>;

  const editable = canEdit && !txn.transfer_id && txn.status !== "void" && !reversed && (txn.kind === "regular" || txn.kind === "invoice");
  const reversible = canEdit && !txn.transfer_id && txn.status === "posted" && !reversed && ["regular", "invoice", "tax_settlement"].includes(txn.kind);
  const voidable = canEdit && txn.status !== "void" && !reversed;
  const canTagWallet = canClassify && txn.status === "posted" && txn.is_cash && perspective === "party" && txn.ledger_id === ledgerId;
  const canTagNature = canClassify && !txn.transfer_id && txn.status === "posted" && txn.kind === "regular" && perspective === "cashbook" && txn.ledger_id === ledgerId;

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error ?? "Could not save");
      toast.success(res.message ?? "Saved");
      router.refresh();
      close();
    });

  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <div className="flex justify-between gap-4 py-2.5">
        <dt className="text-ink-2">{label}</dt>
        <dd className="text-right font-medium">{value}</dd>
      </div>
    ) : null;

  return (
    <Sheet open={Boolean(txn)} onClose={close} title={txn.voucher_no} description={`${KIND_LABEL[txn.kind]} · ${formatDate(txn.txn_date)}`}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Amount
            value={toPaise(txn.amount)}
            size="xl"
            tone={txn.direction === "in" ? "in" : "out"}
            className={txn.status === "void" ? "line-through opacity-50" : undefined}
          />
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={txn.direction === "in" ? "in" : "out"}>
              {txn.is_cash ? (txn.direction === "in" ? "Money in · Credit" : "Money out · Debit") : txn.direction === "in" ? "Credit, no cash" : "Debit, no cash"}
            </Badge>
            {txn.status !== "posted" && <Badge tone={txn.status === "void" ? "neutral" : "warn"}>{txn.status}</Badge>}
            {reversed && <Badge>Reversed</Badge>}
          </div>
        </div>

        {txn.status === "void" && txn.void_reason && (
          <p className="rounded-2xl bg-sunken p-3 text-sm">Voided: {txn.void_reason}</p>
        )}

        <dl className="divide-y divide-line text-[15px]">
          {row("Description", txn.description)}
          {row("Payee", txn.counterparty)}
          {row("Payment mode", paymentModeLabel(txn.payment_mode))}
          {row("Reference", txn.reference_no)}
          {row("Notes", txn.notes)}
          {row("Recorded by", `${names[txn.created_by] ?? "Someone"}${txn.created_via === "collaborator" ? " (collaborator)" : txn.created_via === "import" ? " (import)" : ""}`)}
          {row("Recorded", formatDateTime(txn.created_at))}
          {txn.updated_by && row("Last changed by", `${names[txn.updated_by] ?? "Someone"} · ${formatDateTime(txn.updated_at)}`)}
        </dl>

        {tax && (
          <section className="rounded-[24px] bg-lavender/25 p-4 ring-1 ring-inset ring-lavender/60">
            <h3 className="mb-2 font-semibold">Tax breakdown{tax.invoice_no ? ` · Invoice ${tax.invoice_no}` : ""}</h3>
            <dl className="num grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-ink-2">Taxable</dt>
              <dd className="text-right">{formatINR(toPaise(tax.taxable_amount))}</dd>
              {tax.gst_type === "intra" && (
                <>
                  <dt className="text-ink-2">CGST</dt>
                  <dd className="text-right">{formatINR(toPaise(tax.cgst_amount))}</dd>
                  <dt className="text-ink-2">SGST</dt>
                  <dd className="text-right">{formatINR(toPaise(tax.sgst_amount))}</dd>
                </>
              )}
              {tax.gst_type === "inter" && (
                <>
                  <dt className="text-ink-2">IGST</dt>
                  <dd className="text-right">{formatINR(toPaise(tax.igst_amount))}</dd>
                </>
              )}
              <dt className="text-ink-2">GST {tax.gst_applicable ? formatRate(toRateMilli(tax.gst_rate)) : ""}</dt>
              <dd className="text-right">{formatINR(toPaise(tax.gst_amount))}</dd>
              <dt className="text-ink-2">Gross invoice</dt>
              <dd className="text-right font-medium">{formatINR(toPaise(tax.gross_amount))}</dd>
              <dt className="text-ink-2">
                TDS {tax.tds_applicable ? `${formatRate(toRateMilli(tax.tds_rate))} on ${tax.tds_base === "gross" ? "gross" : "taxable"}` : ""}
                {tax.tds_section ? ` · ${tax.tds_section}` : ""}
              </dt>
              <dd className="text-right">− {formatINR(toPaise(tax.tds_amount))}</dd>
              <dt className="font-semibold">After TDS</dt>
              <dd className="text-right font-semibold">{formatINR(toPaise(tax.net_amount))}</dd>
            </dl>
          </section>
        )}

        {step === "view" && canTagWallet && (
          <Field label="Went through which wallet" optional>
            {(p) => (
              <Select {...p} disabled={pending} value={txn.wallet_ledger_id ?? ""} onChange={(e) => run(() => classifyEntry(txn.id, { wallet_ledger_id: e.target.value }))}>
                <option value="">Not tracked</option>
                {wallets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {step === "view" && canTagNature && (
          <Field label="What was this?" optional>
            {(p) => (
              <Select {...p} disabled={pending} value={txn.nature ?? ""} onChange={(e) => run(() => classifyEntry(txn.id, { nature: e.target.value }))}>
                <option value="">Not decided</option>
                {NATURES.filter((n) => n.direction === txn.direction || n.direction === "both").map((n) => (
                  <option key={n.value} value={n.value}>
                    {n.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {step === "view" && (editable || reversible || voidable) && (
          <div className="grid gap-2 sm:grid-cols-3">
            {editable && <Button variant="primary" onClick={onEdit}>Edit</Button>}
            {reversible && (
              <Button variant="secondary" onClick={() => setStep("reverse")}>
                Reverse
              </Button>
            )}
            {voidable && (
              <Button variant="secondary" onClick={() => setStep("void")}>
                Delete
              </Button>
            )}
          </div>
        )}
        {step === "view" && txn.kind !== "regular" && txn.kind !== "invoice" && txn.kind !== "reversal" && (
          <p className="text-[13px] text-ink-3">
            This entry comes from {txn.kind === "expense" ? "an expense" : txn.kind === "tax_settlement" ? "a tax payment" : "an advance"}. Change
            it there so both records stay in step.
          </p>
        )}

        {step !== "view" && (
          <form
            className="flex flex-col gap-4 rounded-[24px] bg-sunken p-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => (step === "void" ? (txn.transfer_id ? deleteTransfer(txn.transfer_id) : deleteEntry(txn.id, ledgerId)) : reverseEntry(txn.id, ledgerId, reason, date)));
            }}
          >
            <p className="text-[15px]">
              {step === "void"
                ? txn.transfer_id
                  ? "Deletes this transfer for good, both halves."
                  : txn.kind === "expense"
                    ? "Deletes this entry and its expense for good."
                    : txn.kind === "advance_given" || txn.kind === "advance_recovery"
                      ? "Deletes this entry and its advance record for good."
                      : "Deletes this entry for good, with any reversal of it. It cannot be undone."
                : "Reversing posts an equal and opposite entry. Both stay visible and cancel each other out."}
            </p>
            {step === "reverse" && (
              <Field label="Reason">
                {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} autoFocus placeholder="Payment bounced" />}
              </Field>
            )}
            {step === "reverse" && (
              <Field label="Reversal date">
                {(p) => <DateInput {...p} value={date} onChange={setDate} required />}
              </Field>
            )}
            {error && (
              <p role="alert" className="font-medium text-out">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep("view")}>
                Cancel
              </Button>
              <Button type="submit" variant={step === "void" ? "danger" : "primary"} disabled={pending || (step === "reverse" && !reason.trim())} className="flex-1">
                {pending ? "Saving…" : step === "void" ? "Delete for good" : "Post reversal"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Sheet>
  );
}
