"use client";
import { useWallet, WalletSelect, type WalletOption } from "@/components/app/wallet-select";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, CircleDollarSign, CopyPlus, FileUp, Link2, Mail, MessageCircle, MoreHorizontal, Pencil, XCircle } from "lucide-react";
import { emailInvoice } from "@/app/(app)/actions/email";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/bits";
import { Checkbox, Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Sheet } from "@/components/ui/sheet";
import { Money } from "@/components/ui/amount";
import {
  amendInvoice,
  cancelInvoice,
  deleteDraft,
  duplicateInvoice,
  issueInvoice,
  markShared,
  recordPayment,
  recordReminder,
  removeFile,
  reversePayment,
  deletePayment,
  reviewSubmission,
  revokeLink,
  rotateLink,
  setFileVisibility,
  updateClientPage,
} from "@/app/(app)/actions/invoices";
import { ImagePicker } from "@/components/app/invoice/image-picker";
import { configFor } from "@/lib/invoices/editor";
import { onColor } from "@/lib/invoices/doc";
import { REMINDER_LABEL, type ReminderStage, invoiceReminderMessage, invoiceShareMessage } from "@/lib/domain/invoice";
import { formatINR, toDecimal, toPaise, tryPaise } from "@/lib/domain/money";
import { formatDate, formatDateTime, relativeTime } from "@/lib/domain/dates";
import { PAYMENT_MODES, paymentModeLabel } from "@/lib/types";
import { whatsappLink, whatsappNumber } from "@/lib/whatsapp";
import type { AttachmentRow, DocumentMode, PaymentConfig, PaymentProfile, PaymentRow, SubmissionRow } from "@/lib/server/invoices";

type Result = { ok: boolean; error?: string; message?: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Result>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error ?? "That did not work. Try again.");
      if (res.message) toast.success(res.message);
      after?.();
      router.refresh();
    });
  return { pending, run, router };
}

const newKey = () => crypto.randomUUID();

export function DraftActions({ id }: { id: string }) {
  const { pending, run, router } = useRun();
  return (
    <>
      <Button
        size="lg"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          run(async () => {
            const res = await issueInvoice(id);
            return res;
          })
        }
      >
        Issue now
      </Button>
      <Button
        size="lg"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          if (window.confirm("Delete this draft? This cannot be undone.")) run(() => deleteDraft(id), () => router.push("/invoices"));
        }}
      >
        Delete draft
      </Button>
    </>
  );
}

interface InvoiceInfo {
  id: string;
  no: string;
  proforma: boolean;
  open: boolean;
  balance: string;
  total: string;
  received: string;
  due: string | null;
  phone: string | null;
  email: string | null;
  clientName: string;
  business: string;
  notes: string;
  terms: string;
  showQr: boolean;
  allowClaims: boolean;
  showHistory: boolean;
  wallets: WalletOption[];
}

export function InvoiceActions({
  invoice: v,
  url,
  today,
  suggested,
  lastReminder,
  autoOpen,
}: {
  invoice: InvoiceInfo;
  url: string | null;
  today: string;
  suggested: ReminderStage;
  lastReminder: string | null;
  autoOpen?: string;
}) {
  const { pending, run, router } = useRun();
  const [sheet, setSheet] = useState<"pay" | "remind" | "cancel" | "amend" | "email" | null>(autoOpen === "pay" || autoOpen === "remind" || autoOpen === "cancel" ? autoOpen : null);
  const close = () => setSheet(null);
  const share = url ? invoiceShareMessage({ clientName: v.clientName, business: v.business, invoiceNo: v.no, total: toPaise(v.total), dueDate: v.due, url, proforma: v.proforma }) : "";

  return (
    <>
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        {v.open && (
          <Button size="lg" className="h-14" onClick={() => setSheet("pay")}>
            <CircleDollarSign className="size-5" /> Record payment
          </Button>
        )}
        {url ? (
          <a href={whatsappLink(share, whatsappNumber(v.phone))} target="_blank" rel="noopener noreferrer" onClick={() => void markShared(v.id)} className="inline-flex h-14 items-center justify-center gap-2 rounded-full bg-green px-6 font-semibold text-white">
            <MessageCircle className="size-5" /> Share on WhatsApp
          </a>
        ) : (
          <p className="rounded-2xl bg-mustard/30 p-3 text-[14px] font-medium">Sharing is off. Create a link below to send this invoice.</p>
        )}
        {url && (
          <Button
            size="lg"
            variant="secondary"
            className="h-14"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              toast.success("Link copied");
            }}
          >
            <Link2 className="size-4" /> Copy link
          </Button>
        )}
        <Menu
          label="More actions"
          buttonClassName="inline-flex h-14 w-full items-center justify-center gap-2 rounded-full px-5 font-medium ring-1 ring-inset ring-line sm:w-auto"
          button={
            <>
              <MoreHorizontal className="size-5" /> More
            </>
          }
        >
          {(c) => (
            <>
              {url && (
                <MenuItem
                  onSelect={() => {
                    c();
                    setSheet("email");
                  }}
                >
                  <Mail className="size-[18px]" /> Email invoice
                </MenuItem>
              )}
              {v.open && url && (
                <MenuItem
                  onSelect={() => {
                    c();
                    setSheet("remind");
                  }}
                >
                  <Bell className="size-[18px]" /> Send reminder
                </MenuItem>
              )}
              <MenuItem
                onSelect={() => {
                  c();
                  router.push(`/invoices/${v.id}/edit`);
                }}
              >
                <Pencil className="size-[18px]" /> Edit invoice
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  c();
                  setSheet("amend");
                }}
              >
                <Pencil className="size-[18px]" /> Quick edit: notes or due date
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  c();
                  run(
                    async () => {
                      const res = await duplicateInvoice(v.id);
                      if (res.ok) router.push(`/invoices/${res.data!.id}/edit`);
                      return res;
                    },
                  );
                }}
              >
                <CopyPlus className="size-[18px]" /> Duplicate
              </MenuItem>
              {v.proforma && (
                <MenuItem
                  onSelect={() => {
                    c();
                    run(async () => {
                      const res = await duplicateInvoice(v.id, "service");
                      if (res.ok) router.push(`/invoices/${res.data!.id}/edit`);
                      return res;
                    });
                  }}
                >
                  <CopyPlus className="size-[18px]" /> Convert to invoice
                </MenuItem>
              )}
              <MenuItem
                danger
                onSelect={() => {
                  c();
                  setSheet("cancel");
                }}
              >
                <XCircle className="size-[18px]" /> Cancel invoice
              </MenuItem>
            </>
          )}
        </Menu>
      </div>

      {sheet === "pay" && <PaymentSheet v={v} today={today} onClose={close} />}
      {sheet === "email" && <EmailInvoiceSheet v={v} onClose={close} />}
      {sheet === "remind" && url && <ReminderSheet v={v} url={url} today={today} suggested={suggested} lastReminder={lastReminder} onClose={close} />}
      {sheet === "amend" && <AmendSheet v={v} onClose={close} />}
      {sheet === "cancel" && <CancelSheet v={v} pending={pending} run={run} onClose={close} />}
    </>
  );
}

function PaymentSheet({ v, today, onClose }: { v: InvoiceInfo; today: string; onClose: () => void }) {
  const { pending, run } = useRun();
  const balance = BigInt(v.balance);
  const [amount, setAmount] = useState(toDecimal(balance).replace(/\.00$/, ""));
  const [tds, setTds] = useState("");
  const [date, setDate] = useState(today);
  const [mode, setMode] = useState("upi");
  const wallet = useWallet(v.wallets, mode);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [excess, setExcess] = useState(false);
  const [key] = useState(newKey);
  const paise = tryPaise(amount) ?? 0n;
  const tdsPaise = tryPaise(tds) ?? 0n;
  const settled = paise + tdsPaise;
  const over = settled > balance;
  // TDS typed in while the amount still reads the full balance: the cash is what is left.
  const changeTds = (value: string) => {
    const before = tryPaise(tds) ?? 0n;
    if (paise === balance - before) setAmount(toDecimal(balance - (tryPaise(value) ?? 0n)).replace(/\.00$/, ""));
    setTds(value);
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Record payment"
      description={`Invoice ${v.no}`}
      footer={
        <Button
          size="lg"
          className="w-full"
          disabled={pending || paise <= 0n || (over && !excess)}
          onClick={() => run(() => recordPayment(v.id, { amount, paid_on: date, mode: mode as "upi", reference, notes, allow_excess: excess, idempotency_key: key, wallet_ledger_id: wallet.value, tds_deducted: tds }), onClose)}
        >
          {pending ? "Saving…" : tdsPaise > 0n ? `Record ${formatINR(paise)} + ${formatINR(tdsPaise)} TDS` : `Record ${formatINR(paise)}`}
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pb-1">
        <dl className="divide-y divide-line rounded-2xl bg-white px-4 text-[15px] ring-1 ring-inset ring-line">
          <div className="flex justify-between py-2.5">
            <dt className="text-ink-2">Invoice amount</dt>
            <dd className="num font-medium">{formatINR(toPaise(v.total))}</dd>
          </div>
          <div className="flex justify-between py-2.5">
            <dt className="text-ink-2">Already received</dt>
            <dd className="num font-medium">{formatINR(toPaise(v.received))}</dd>
          </div>
          <div className="flex justify-between py-2.5">
            <dt className="text-ink-2">Outstanding</dt>
            <dd className="num font-medium">{formatINR(balance)}</dd>
          </div>
          <div className="flex justify-between py-2.5 font-semibold">
            <dt>New balance</dt>
            <dd className="num">{formatINR(over ? 0n : balance - settled)}</dd>
          </div>
        </dl>
        <Field label="Amount received">{(p) => <MoneyInput {...p} big value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />}</Field>
        <Field label="TDS deducted by client" optional hint="If they paid less because they deducted TDS. It settles the invoice too, and becomes your TDS credit; only the cash goes to the bank.">
          {(p) => <MoneyInput {...p} value={tds} onChange={(e) => changeTds(e.target.value)} placeholder="0" />}
        </Field>
        {over && <Checkbox label={`Yes, ${formatINR(settled - balance)} more than the balance was settled`} checked={excess} onChange={(e) => setExcess(e.target.checked)} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Payment date">{(p) => <DateInput {...p} value={date} onChange={setDate} />}</Field>
          <Field label="Mode">
            {(p) => (
              <Select {...p} value={mode} onChange={(e) => setMode(e.target.value)}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <WalletSelect wallets={v.wallets} value={wallet.value} onChange={wallet.setValue} label="Received into" hint="The money shows in this wallet, once. Follows the mode until you change it." />
        <Field label="UTR or reference" optional hint="The same reference cannot be recorded twice">
          {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} autoComplete="off" />}
        </Field>
        <Field label="Notes" optional>{(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />}</Field>
      </div>
    </Sheet>
  );
}

function ReminderSheet({ v, url, today, suggested, lastReminder, onClose }: { v: InvoiceInfo; url: string; today: string; suggested: ReminderStage; lastReminder: string | null; onClose: () => void }) {
  const { run } = useRun();
  const [stage, setStage] = useState<ReminderStage>(suggested);
  const [text, setText] = useState(() => invoiceReminderMessage({ clientName: v.clientName, invoiceNo: v.no, outstanding: BigInt(v.balance), dueDate: v.due, url, stage: suggested }));
  const recent = lastReminder && lastReminder.slice(0, 10) === today;
  return (
    <Sheet open onClose={onClose} title="Send a reminder" description="Opens WhatsApp with this message. You press send there.">
      <div className="flex flex-col gap-4 pb-2">
        {recent && <p className="rounded-2xl bg-mustard/30 p-3 text-[14px] font-medium">You already reminded them today ({relativeTime(lastReminder)}).</p>}
        <Field label="When">
          {(p) => (
            <Select
              {...p}
              value={stage}
              onChange={(e) => {
                const s = e.target.value as ReminderStage;
                setStage(s);
                setText(invoiceReminderMessage({ clientName: v.clientName, invoiceNo: v.no, outstanding: BigInt(v.balance), dueDate: v.due, url, stage: s }));
              }}
            >
              {Object.entries(REMINDER_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Message">{(p) => <Textarea {...p} value={text} onChange={(e) => setText(e.target.value)} className="min-h-56" />}</Field>
        <a
          href={whatsappLink(text, whatsappNumber(v.phone))}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => run(() => recordReminder(v.id, stage), onClose)}
          className="inline-flex h-14 items-center justify-center gap-2 rounded-full bg-green font-semibold text-white"
        >
          <MessageCircle className="size-5" /> Open WhatsApp
        </a>
      </div>
    </Sheet>
  );
}

/** Sends the invoice link by email, in Lekha's invoice email (view, download and pay). */
function EmailInvoiceSheet({ v, onClose }: { v: InvoiceInfo; onClose: () => void }) {
  const { pending, run } = useRun();
  const [to, setTo] = useState(v.email ?? "");
  return (
    <Sheet open onClose={onClose} title={`Email ${v.no}`} description="Your client gets the invoice with a button to view, download and pay. Replies come to your email.">
      <div className="flex flex-col gap-4 pb-2">
        <Field label="Client email">{(p) => <Input {...p} type="email" value={to} onChange={(e) => setTo(e.target.value)} maxLength={200} autoComplete="email" />}</Field>
        <Button size="lg" disabled={pending || !to.trim()} onClick={() => run(() => emailInvoice(v.id, to), onClose)}>
          <Mail className="size-4" /> {pending ? "Sending…" : "Send invoice email"}
        </Button>
      </div>
    </Sheet>
  );
}

function AmendSheet({ v, onClose }: { v: InvoiceInfo; onClose: () => void }) {
  const { pending, run } = useRun();
  const [due, setDue] = useState(v.due ?? "");
  const [notes, setNotes] = useState(v.notes);
  const [terms, setTerms] = useState(v.terms);
  const [showQr, setShowQr] = useState(v.showQr);
  const [claims, setClaims] = useState(v.allowClaims);
  const [history, setHistory] = useState(v.showHistory);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Amend invoice"
      description="Amounts and the invoice number stay locked. Every change is on the timeline."
      footer={
        <Button size="lg" className="w-full" disabled={pending} onClick={() => run(() => amendInvoice(v.id, { due_date: due, notes, terms, show_digital_qr: showQr, allow_payment_claims: claims, show_payment_history: history }), onClose)}>
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pb-1">
        <Field label="Due date">{(p) => <DateInput {...p} value={due} onChange={setDue} />}</Field>
        <Field label="Notes" optional>{(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={3000} />}</Field>
        <Field label="Terms" optional>{(p) => <Textarea {...p} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={3000} />}</Field>
        <Checkbox label="Digital-copy QR on the PDF" checked={showQr} onChange={(e) => setShowQr(e.target.checked)} />
        <Checkbox label="Let the client say they have paid" checked={claims} onChange={(e) => setClaims(e.target.checked)} />
        <Checkbox label="Show payments received to the client" checked={history} onChange={(e) => setHistory(e.target.checked)} />
      </div>
    </Sheet>
  );
}

function CancelSheet({ v, pending, run, onClose }: { v: InvoiceInfo; pending: boolean; run: (fn: () => Promise<Result>, after?: () => void) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <Sheet open onClose={onClose} title="Cancel this invoice?" description="The number stays used, the receivable is reversed in the ledger, and the link stops working.">
      <div className="flex flex-col gap-4 pb-2">
        <Field label="Reason">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>
        <Button variant="danger" size="lg" disabled={pending || !reason.trim()} onClick={() => run(() => cancelInvoice(v.id, reason), onClose)}>
          Cancel invoice
        </Button>
      </div>
    </Sheet>
  );
}

export function PaymentHistory({ invoiceId, payments, canWrite }: { invoiceId: string; payments: PaymentRow[]; canWrite: boolean }) {
  const { pending, run } = useRun();
  const [target, setTarget] = useState<PaymentRow | null>(null);
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<"correction" | "refund">("correction");
  if (payments.length === 0) return <p className="rounded-[24px] bg-surface p-5 text-ink-2 ring-1 ring-inset ring-line/70">No payments recorded yet.</p>;
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-[24px] bg-surface ring-1 ring-inset ring-line/70">
        {payments.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-medium">
                {formatDate(p.paid_on)}
                {p.mode ? ` · ${paymentModeLabel(p.mode)}` : ""}
                {Number(p.tds_deducted) > 0 ? ` · + ${formatINR(toPaise(p.tds_deducted))} TDS` : ""}
              </div>
              <div className="truncate text-[13px] text-ink-3">
                {[p.reference, p.source === "client_claim" ? "Confirmed from client note" : null, p.transaction_id ? "In ledger" : null, p.notes].filter(Boolean).join(" · ") || "Recorded by hand"}
              </div>
              {p.status === "reversed" && <div className="text-[13px] text-out">{p.reversal_kind === "refund" ? "Refunded" : "Reversed"}: {p.reversal_reason}</div>}
            </div>
            <Money value={toPaise(p.amount)} className={p.status === "reversed" ? "font-semibold line-through opacity-50" : "font-semibold text-in"} />
            {canWrite && p.status === "confirmed" && (
              <Button size="sm" variant="ghost" onClick={() => setTarget(p)}>
                Reverse
              </Button>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  if (!confirm("Delete this payment for good? Its bank and TDS entries go with it, and the invoice balance comes back.")) return;
                  run(() => deletePayment(p.id, invoiceId));
                }}
              >
                Delete
              </Button>
            )}
          </li>
        ))}
      </ul>
      {target && (
        <Sheet open onClose={() => setTarget(null)} title="Reverse this payment?" description={`${formatINR(toPaise(target.amount))} on ${formatDate(target.paid_on)}. The record stays, and a contra entry goes to the ledger.`}>
          <div className="flex flex-col gap-4 pb-2">
            <Field label="Why">
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as "correction")}>
                  <option value="correction">Recorded by mistake, or the payment bounced</option>
                  <option value="refund">Refunded to the client</option>
                </Select>
              )}
            </Field>
            <Field label="Reason">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>
            <Button variant="danger" size="lg" disabled={pending || !reason.trim()} onClick={() => run(() => reversePayment(target.id, invoiceId, reason, kind), () => setTarget(null))}>
              Reverse payment
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}

export function SubmissionsPanel({ invoiceId, canWrite, items, balance }: { invoiceId: string; canWrite: boolean; items: SubmissionRow[]; balance: string }) {
  const { pending, run } = useRun();
  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-mustard p-5 text-ink">
      <h2 className="display text-xl font-bold">Waiting for you to check</h2>
      <p className="text-[14px]">The client says they paid. Check your account first. Nothing changes until you confirm.</p>
      {items.map((s) => {
        const over = toPaise(s.amount) > BigInt(balance);
        return (
          <div key={s.id} className="flex flex-col gap-3 rounded-2xl bg-white p-4">
            <div className="flex justify-between gap-3">
              <div>
                <div className="num text-lg font-bold">{formatINR(toPaise(s.amount))}</div>
                <div className="text-[13px] text-ink-2">
                  {[formatDate(s.paid_on), paymentModeLabel(s.mode), s.reference && `UTR ${s.reference}`].filter(Boolean).join(" · ")}
                </div>
                {s.message && <p className="mt-1 text-[14px]">{s.message}</p>}
              </div>
              {s.proof_received && (
                <a href={`/api/invoices/proofs/${s.id}`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-sm font-semibold underline underline-offset-4">
                  View proof
                </a>
              )}
            </div>
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={pending} onClick={() => run(() => reviewSubmission(s.id, invoiceId, true, { allow_excess: over }))}>
                  Confirm received
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => run(() => reviewSubmission(s.id, invoiceId, false))}>
                  Not received
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

const MODES: { value: DocumentMode; label: string; hint: string }[] = [
  { value: "uploaded", label: "Only my document", hint: "They view your uploaded file. No Lekha format is shown." },
  { value: "lekha", label: "Lekha invoice", hint: "They get the invoice generated by Lekha." },
  { value: "both", label: "Both", hint: "Your file, plus a summary PDF generated by Lekha." },
];

/** What the client sees when they open the link. None of this changes any amount. */
export function ClientPagePanel({
  id,
  issued,
  mode: initialMode,
  hasDocument,
  color,
  fallback,
  logo,
  profiles,
  config,
  title: initialTitle,
}: {
  id: string;
  title: string;
  issued: boolean;
  mode: DocumentMode;
  hasDocument: boolean;
  color: string | null;
  fallback: string;
  logo: string | null;
  profiles: PaymentProfile[];
  config: PaymentConfig;
}) {
  const { pending, run } = useRun();
  const [mode, setMode] = useState(initialMode);
  const [card, setCard] = useState(color);
  const [clientLogo, setClientLogo] = useState(logo);
  const [title, setTitle] = useState(initialTitle);
  const [profile, setProfile] = useState(config.none ? "none" : (config.profile_id ?? ""));
  const shown = card ?? fallback;

  const save = () => {
    const chosen = profiles.find((p) => p.id === profile);
    const payment = profile === (config.none ? "none" : (config.profile_id ?? "")) || !issued ? undefined : profile === "none" ? { none: true } : profile ? configFor(chosen) : {};
    run(() => updateClientPage(id, { document_mode: mode, card_color: card ?? "", client_logo_path: clientLogo ?? "", title }, payment as Record<string, unknown> | undefined));
  };

  return (
    <div className="flex flex-col gap-4 rounded-[24px] bg-surface p-5 ring-1 ring-inset ring-line/70">
      <Field label="Invoice title" optional hint="Shown on the client page and in the WhatsApp preview. Amounts stay locked.">
        {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}
      </Field>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium text-ink-2">What your client receives</legend>
        {MODES.map((m) => (
          <label key={m.value} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
            <input type="radio" name="document-mode" checked={mode === m.value} onChange={() => setMode(m.value)} className="mt-0.5 size-5 shrink-0 accent-[#1d1d1b]" />
            <span className="flex flex-col">
              <span className="text-[15px] font-medium">{m.label}</span>
              <span className="text-[13px] text-ink-3">{m.hint}</span>
            </span>
          </label>
        ))}
        {mode !== "lekha" && !hasDocument && <p className="rounded-2xl bg-mustard/30 p-3 text-[14px] font-medium">Attach your invoice under Documents first.</p>}
      </fieldset>

      {issued && (
        <Field label="Payment details" hint="Saved in Invoice settings. Leave on default to use your default profile.">
          {(p) => (
            <Select {...p} value={profile} onChange={(e) => setProfile(e.target.value)}>
              <option value="">Default payment profile</option>
              {profiles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
              <option value="none">Show no payment details</option>
            </Select>
          )}
        </Field>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-ink-2">Card colour</span>
        <div className="flex items-center gap-3">
          <input type="color" aria-label="Card colour" value={shown} onChange={(e) => setCard(e.target.value)} className="h-12 w-20 rounded-[var(--radius-field)] bg-white p-1 ring-1 ring-inset ring-line" />
          <div className="flex h-12 min-w-0 flex-1 items-center rounded-2xl px-4 text-[15px] font-semibold" style={{ background: shown, color: onColor(shown) }}>
            Amount due
          </div>
          {card && (
            <Button size="sm" variant="ghost" onClick={() => setCard(null)}>
              Default
            </Button>
          )}
        </div>
      </div>

      <ImagePicker label="Client's logo" field="client" path={clientLogo} onPath={setClientLogo} />

      <Button disabled={pending} onClick={save} className="self-start">
        {pending ? "Saving…" : "Save client page"}
      </Button>
    </div>
  );
}

export function LinkPanel({
  id,
  url,
  link,
}: {
  id: string;
  url: string | null;
  link: { token_hint: string; expires_at: string | null; view_count: number; last_viewed_at: string | null } | null;
}) {
  const { pending, run } = useRun();
  const [days, setDays] = useState("");
  return (
    <div className="flex flex-col gap-3 rounded-[24px] bg-surface p-5 ring-1 ring-inset ring-line/70">
      {link ? (
        <>
          <div className="flex items-center gap-2">
            <Badge tone="in">Live</Badge>
            <span className="text-[14px] text-ink-2">
              {link.view_count ? `Opened ${link.view_count} ${link.view_count === 1 ? "time" : "times"}, last ${relativeTime(link.last_viewed_at!)}` : "Not opened yet"}
              {link.expires_at ? ` · expires ${formatDateTime(link.expires_at)}` : ""}
            </span>
          </div>
          {url && <p className="break-all font-mono text-[13px] text-ink-2">{url}</p>}
        </>
      ) : (
        <p className="text-[15px] text-ink-2">Sharing is off. The old link does not open.</p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Link expiry" className="min-w-40">
          {(p) => (
            <Select {...p} value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="">Never</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </Select>
          )}
        </Field>
        <Button variant="secondary" disabled={pending} onClick={() => run(() => rotateLink(id, days ? Number(days) : undefined))}>
          {link ? "Create a new link" : "Turn on sharing"}
        </Button>
        {link && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Turn off this link? It stops opening straight away.")) run(() => revokeLink(id));
            }}
          >
            Turn off
          </Button>
        )}
      </div>
    </div>
  );
}

export function FilesPanel({ id, files, canWrite, draft, source }: { id: string; files: AttachmentRow[]; canWrite: boolean; draft: boolean; source: string }) {
  const { pending, run, router } = useRun();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [role, setRole] = useState<"original" | "supporting">("supporting");

  const upload = (file: File) => {
    const form = new FormData();
    form.set("file", file);
    form.set("role", role);
    form.set("client_visible", "false");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/invoices/${id}/files`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      setProgress(null);
      const body = JSON.parse(xhr.responseText || "{}") as { error?: string };
      if (xhr.status >= 400) return void toast.error(body.error ?? "The file could not be uploaded");
      toast.success("File attached. It stays private until you share it.");
      router.refresh();
    };
    xhr.onerror = () => {
      setProgress(null);
      toast.error("Upload failed. Check your connection.");
    };
    setProgress(0);
    xhr.send(form);
  };

  return (
    <div className="flex flex-col gap-3 rounded-[24px] bg-surface p-5 ring-1 ring-inset ring-line/70">
      {files.length === 0 && <p className="text-[15px] text-ink-2">No documents attached.</p>}
      <ul className="flex flex-col divide-y divide-line">
        {files.map((f) => (
          <li key={f.id} className="flex flex-col gap-2 py-3 first:pt-0">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{f.file_name}</span>
              {f.role === "original" && <Badge tone="ink">Invoice document</Badge>}
            </div>
            <div className="text-[13px] text-ink-3">
              {(f.size_bytes / 1024 / 1024).toFixed(2)} MB{f.page_count ? ` · ${f.page_count} ${f.page_count === 1 ? "page" : "pages"}` : ""} · kept exactly as uploaded
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <a href={`/api/invoices/files/${f.id}`} className="text-sm font-semibold underline underline-offset-4">
                Download
              </a>
              {f.mime_type !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && (
                <a href={`/api/invoices/files/${f.id}?inline=1`} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold underline underline-offset-4">
                  Preview
                </a>
              )}
              {canWrite && <Checkbox label="Client can download" checked={f.client_visible} disabled={pending} onChange={(e) => run(() => setFileVisibility(f.id, id, e.target.checked))} />}
              {canWrite && (f.role !== "original" || draft) && (
                <button type="button" disabled={pending} className="text-sm font-medium text-out" onClick={() => window.confirm(`Remove ${f.file_name}?`) && run(() => removeFile(f.id, id))}>
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          {((draft && source === "uploaded") || !files.some((x) => x.role === "original")) && (
            <select aria-label="Attach as" value={role} onChange={(e) => setRole(e.target.value as "original")} className="h-12 rounded-full bg-sunken px-4 text-sm">
              <option value="supporting">Supporting file</option>
              <option value="original">My invoice document</option>
            </select>
          )}
          <Button variant="secondary" disabled={progress !== null} onClick={() => input.current?.click()}>
            <FileUp className="size-4" /> {progress !== null ? `Uploading ${progress}%` : "Attach a file"}
          </Button>
          <span className="text-[13px] text-ink-3">PDF, Word, PNG or JPG, up to 4 MB</span>
          <input
            ref={input}
            type="file"
            className="sr-only"
            tabIndex={-1}
            accept=".pdf,.docx,.png,.jpg,.jpeg"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) upload(f);
            }}
          />
        </div>
      )}
    </div>
  );
}
