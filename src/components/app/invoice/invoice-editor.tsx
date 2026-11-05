"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, CopyPlus, Link2, MessageCircle, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { INVOICE_TYPES, TEMPLATES, invoiceShareMessage } from "@/lib/domain/invoice";
import { GST_STATES } from "@/lib/domain/india";
import { formatINR } from "@/lib/domain/money";
import { docFromDraft, totalRows } from "@/lib/invoices/doc";
import { type EditorState, blankItem, configFor, previewPayment } from "@/lib/invoices/editor";
import type { InvoiceSettings, LibraryItem, PaymentConfig, PaymentProfile } from "@/lib/server/invoices";
import { whatsappLink, whatsappNumber } from "@/lib/whatsapp";
import { createClientLedger, issueInvoice, markShared, saveDraft, saveLibraryItem } from "@/app/(app)/actions/invoices";
import { InvoiceSheet } from "./invoice-sheet";
import { ScaledSheet } from "./scaled-sheet";

interface ClientOption {
  id: string;
  name: string;
  business_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}

const STEPS = ["Details", "Client", "Items", "Totals", "Notes", "Payment", "Preview"] as const;
type Step = (typeof STEPS)[number];

export function InvoiceEditor({
  initial,
  settings,
  profiles,
  clients,
  ledgers,
  library,
}: {
  initial: EditorState;
  settings: InvoiceSettings;
  profiles: PaymentProfile[];
  clients: ClientOption[];
  ledgers: { id: string; name: string; contractor_id: string | null }[];
  library: LibraryItem[];
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [step, setStep] = useState<Step>("Details");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [extraLedgers, setExtraLedgers] = useState<typeof ledgers>([]);
  const [confirm, setConfirm] = useState(false);
  const [issued, setIssued] = useState<{ id: string; no: string; url: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<EditorState>) => setForm((f) => ({ ...f, ...patch }));

  const gstOn = Boolean(settings.gst_registered) && (form.invoice_type === "gst" || form.gst_enabled);
  const payment = useMemo(() => previewPayment(form.payment_config, profiles), [form.payment_config, profiles]);
  const doc = useMemo(() => docFromDraft(form, settings, payment, null), [form, settings, payment]);
  const allLedgers = [...ledgers, ...extraLedgers];
  const linked = allLedgers.find((l) => l.id === form.ledger_id);
  const stepIndex = STEPS.indexOf(step);

  const save = async () => {
    setErrors({});
    // An empty last line is not an error in a draft: it simply is not saved.
    const items = form.items.filter((i) => i.name.trim() || i.rate.trim());
    const res = await saveDraft({ ...form, invoice_type: form.invoice_type as "service", items, payment_config: form.payment_config as Record<string, unknown> });
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return null;
    }
    const id = res.data!.id;
    set({ id, save_client: false });
    return id;
  };

  const saveOnly = () =>
    start(async () => {
      const id = await save();
      if (!id) return;
      toast.success("Draft saved");
      if (!form.id) router.replace(`/invoices/${id}/edit`);
    });

  const issue = () =>
    start(async () => {
      const id = await save();
      if (!id) return setConfirm(false);
      const res = await issueInvoice(id);
      setConfirm(false);
      if (!res.ok) return void toast.error(res.error);
      setIssued({ id, no: res.data!.invoiceNo, url: res.data!.url });
      router.refresh();
    });

  const message = issued
    ? invoiceShareMessage({ clientName: form.client_contact || form.client_name, business: doc.seller.name, invoiceNo: issued.no, total: doc.grand, dueDate: form.due_date, url: issued.url, proforma: form.invoice_type === "proforma" })
    : "";

  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
      <div className="flex min-w-0 flex-col gap-5">
        <nav aria-label="Invoice steps" className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0" data-no-swipe>
          {STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-current={s === step ? "step" : undefined}
              onClick={() => setStep(s)}
              className={cn(
                "h-10 shrink-0 rounded-full px-4 text-sm font-medium",
                s === "Preview" && "lg:hidden",
                s === step ? "bg-ink text-surface" : "bg-sunken text-ink-2",
              )}
            >
              {i + 1}. {s}
            </button>
          ))}
        </nav>

        {step === "Details" && <DetailsStep form={form} set={set} errors={errors} gstRegistered={Boolean(settings.gst_registered)} />}
        {step === "Client" && (
          <ClientStep
            form={form}
            set={set}
            clients={clients}
            ledgers={allLedgers}
            errors={errors}
            onLedgerCreated={(l) => {
              setExtraLedgers((x) => [...x, l]);
              set({ ledger_id: l.id });
            }}
          />
        )}
        {step === "Items" && <ItemsStep form={form} set={set} doc={doc} gst={gstOn} library={library.filter((l) => l.kind === "item")} errors={errors} />}
        {step === "Totals" && <TotalsStep form={form} set={set} doc={doc} gst={gstOn} />}
        {step === "Notes" && <NotesStep form={form} set={set} library={library} />}
        {step === "Payment" && <PaymentStep form={form} set={set} profiles={profiles} />}
        {step === "Preview" && (
          <div className="overflow-hidden rounded-2xl ring-1 ring-line lg:hidden">
            <ScaledSheet>
              <InvoiceSheet doc={doc} />
            </ScaledSheet>
          </div>
        )}

        <div className="no-print sticky bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-20 flex items-center gap-2 rounded-full bg-surface/95 p-2 shadow-[0_8px_24px_rgb(29_29_27/0.14)] ring-1 ring-line backdrop-blur lg:bottom-4">
          <Button variant="ghost" disabled={pending} onClick={saveOnly} aria-label="Save as draft" className="shrink-0 px-4">
            <Save className="size-4" /> <span className="hidden sm:inline">Save draft</span>
          </Button>
          <span className="num min-w-0 flex-1 truncate text-right text-[15px] font-bold">{formatINR(doc.grand)}</span>
          {step !== "Preview" && stepIndex < STEPS.length - 2 && (
            <Button variant="secondary" className="shrink-0" onClick={() => setStep(STEPS[stepIndex + 1])}>
              Next
            </Button>
          )}
          <Button
            className="shrink-0"
            disabled={pending}
            onClick={() => {
              if (!form.client_name.trim()) {
                setStep("Client");
                return void toast.error("Add the client first");
              }
              if (doc.grand <= 0n) {
                setStep("Items");
                return void toast.error("Add at least one line with an amount");
              }
              setConfirm(true);
            }}
          >
            Issue
          </Button>
        </div>
      </div>

      <aside className="sticky top-6 hidden max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-2xl ring-1 ring-line lg:block" aria-label="Live preview">
        <ScaledSheet>
          <InvoiceSheet doc={doc} />
        </ScaledSheet>
      </aside>

      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Issue this invoice?" description="After this, the amounts are locked. Corrections go through cancelling or amending, and stay on record.">
        <div className="flex flex-col gap-3 pb-2 text-[15px]">
          <dl className="divide-y divide-line rounded-2xl bg-white px-4 ring-1 ring-inset ring-line">
            <Row label="Client" value={form.client_business || form.client_name} />
            <Row label="Total" value={formatINR(doc.grand)} />
            <Row label="Number" value={form.invoice_no || "Next in your series"} />
            <Row
              label="Ledger"
              value={form.invoice_type === "proforma" ? "Nothing posted: this is a proforma" : linked ? `Adds ${formatINR(doc.grand)} receivable to ${linked.name}` : "Not linked to a ledger"}
            />
          </dl>
          {!doc.payment.upi && !doc.payment.bank && !doc.payment.cash && !doc.payment.cheque && !doc.payment.other && (
            <p className="rounded-2xl bg-mustard/30 p-3 font-medium">No payment details are selected. Your client will not see how to pay.</p>
          )}
          <Button size="lg" disabled={pending} onClick={issue}>
            {pending ? "Issuing…" : "Issue invoice"}
          </Button>
        </div>
      </Sheet>

      <Sheet open={Boolean(issued)} onClose={() => router.push(`/invoices/${issued?.id}`)} title="Invoice issued" description={issued ? `${issued.no} is live. Send it to your client.` : undefined}>
        {issued && (
          <div className="flex flex-col gap-2 pb-2">
            <a
              href={whatsappLink(message, whatsappNumber(form.client_phone))}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => void markShared(issued.id)}
              className="inline-flex h-14 items-center justify-center gap-2 rounded-full bg-green font-semibold text-white"
            >
              <MessageCircle className="size-5" /> Share on WhatsApp
            </a>
            <Button
              size="lg"
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(issued.url);
                toast.success("Link copied");
              }}
            >
              <Link2 className="size-4" /> Copy invoice link
            </Button>
            <Link href={`/invoices/${issued.id}`} className="inline-flex h-12 items-center justify-center font-medium underline underline-offset-4">
              Go to the invoice
            </Link>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-3">
      <dt className="text-ink-2">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </div>
  );
}

type StepProps = { form: EditorState; set: (p: Partial<EditorState>) => void };

function Card({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-4 ring-1 ring-inset ring-line/70 sm:p-5">{children}</section>;
}

function DetailsStep({ form, set, errors, gstRegistered }: StepProps & { errors: Record<string, string>; gstRegistered: boolean }) {
  return (
    <Card>
      <Field label="Invoice type">
        {(p) => (
          <Select {...p} value={form.invoice_type} onChange={(e) => set({ invoice_type: e.target.value, template: INVOICE_TYPES.find((t) => t.value === e.target.value)?.template ?? form.template })}>
            {INVOICE_TYPES.filter((t) => t.value !== "gst" || gstRegistered || form.invoice_type === "gst").map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {form.invoice_type === "gst" && !gstRegistered && (
        <p className="rounded-2xl bg-mustard/30 p-3 text-[14px] font-medium">
          Turn on GST registration in{" "}
          <Link href="/invoices/settings" className="underline">
            Invoice settings
          </Link>{" "}
          to issue a tax invoice.
        </p>
      )}
      <Field label="Title or project" optional error={errors.title}>
        {(p) => <Input {...p} value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} placeholder="Website for Regal Impex" />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Invoice date" error={errors.invoice_date}>
          {(p) => <DateInput {...p} value={form.invoice_date} onChange={(v) => set({ invoice_date: v })} />}
        </Field>
        <Field label="Due date" optional error={errors.due_date}>
          {(p) => <DateInput {...p} value={form.due_date} onChange={(v) => set({ due_date: v })} />}
        </Field>
      </div>
      <Field label="Invoice number" optional hint="Leave empty for the next number in your series. It is given when you issue." error={errors.invoice_no}>
        {(p) => <Input {...p} value={form.invoice_no} onChange={(e) => set({ invoice_no: e.target.value })} maxLength={60} placeholder="Automatic" />}
      </Field>
      <Field label="Payment terms" optional>
        {(p) => <Input {...p} value={form.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} maxLength={200} placeholder="Due on receipt" />}
      </Field>
      <Field label="Template">
        {(p) => (
          <Select {...p} value={form.template} onChange={(e) => set({ template: e.target.value })}>
            {TEMPLATES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}: {t.hint}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Card>
  );
}

function ClientStep({
  form,
  set,
  clients,
  ledgers,
  errors,
  onLedgerCreated,
}: StepProps & {
  clients: ClientOption[];
  ledgers: { id: string; name: string; contractor_id: string | null }[];
  errors: Record<string, string>;
  onLedgerCreated: (l: { id: string; name: string; contractor_id: string | null }) => void;
}) {
  const [pending, start] = useTransition();
  const mine = ledgers.filter((l) => l.contractor_id === form.contractor_id);
  const others = ledgers.filter((l) => l.contractor_id !== form.contractor_id);
  const pick = (id: string) => {
    const c = clients.find((x) => x.id === id);
    if (!c) return set({ contractor_id: "", save_client: true });
    const own = ledgers.find((l) => l.contractor_id === c.id);
    set({
      contractor_id: c.id,
      save_client: false,
      client_name: c.name,
      client_business: c.business_name ?? "",
      client_phone: c.phone ?? "",
      client_email: c.email ?? "",
      client_address: c.address ?? "",
      ledger_id: own?.id ?? form.ledger_id,
    });
  };
  return (
    <Card>
      <Field label="Client">
        {(p) => (
          <Select {...p} value={form.contractor_id} onChange={(e) => pick(e.target.value)}>
            <option value="">New client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.business_name ? `${c.business_name} (${c.name})` : c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client name" error={errors.client_name}>
          {(p) => <Input {...p} value={form.client_name} onChange={(e) => set({ client_name: e.target.value })} maxLength={160} autoComplete="off" />}
        </Field>
        <Field label="Business name" optional>
          {(p) => <Input {...p} value={form.client_business} onChange={(e) => set({ client_business: e.target.value })} maxLength={160} autoComplete="off" />}
        </Field>
        <Field label="Contact person" optional>
          {(p) => <Input {...p} value={form.client_contact} onChange={(e) => set({ client_contact: e.target.value })} maxLength={160} autoComplete="off" />}
        </Field>
        <Field label="WhatsApp number" optional hint="Share opens this chat directly">
          {(p) => <Input {...p} type="tel" inputMode="tel" value={form.client_phone} onChange={(e) => set({ client_phone: e.target.value })} maxLength={20} autoComplete="off" />}
        </Field>
      </div>
      <Field label="Email" optional>
        {(p) => <Input {...p} type="email" value={form.client_email} onChange={(e) => set({ client_email: e.target.value })} maxLength={200} autoComplete="off" />}
      </Field>
      <Field label="Billing address" optional>
        {(p) => <Textarea {...p} value={form.client_address} onChange={(e) => set({ client_address: e.target.value })} maxLength={500} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="State" optional>
          {(p) => (
            <Select
              {...p}
              value={GST_STATES.find((s) => s.name === form.client_state)?.code ?? ""}
              onChange={(e) => {
                const s = GST_STATES.find((x) => x.code === e.target.value);
                set({ client_state: s?.name ?? "", place_of_supply: s?.code ?? form.place_of_supply });
              }}
            >
              <option value="">Not set</option>
              {GST_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Country" optional>
          {(p) => <Input {...p} value={form.client_country} onChange={(e) => set({ client_country: e.target.value })} maxLength={60} />}
        </Field>
        <Field label="GSTIN" optional>
          {(p) => <Input {...p} value={form.client_gstin} onChange={(e) => set({ client_gstin: e.target.value.toUpperCase() })} maxLength={15} autoComplete="off" />}
        </Field>
        <Field label="PAN" optional>
          {(p) => <Input {...p} value={form.client_pan} onChange={(e) => set({ client_pan: e.target.value.toUpperCase() })} maxLength={10} autoComplete="off" />}
        </Field>
      </div>
      {!form.contractor_id && <Checkbox label="Save to Client Accounts" hint="Keeps them for next time, without typing again" checked={form.save_client} onChange={(e) => set({ save_client: e.target.checked })} />}
      <Field label="Ledger" optional hint="Issuing adds the amount owed to this ledger, and payments reduce it. No money is counted until it is received.">
        {(p) => (
          <Select {...p} value={form.ledger_id} onChange={(e) => set({ ledger_id: e.target.value })}>
            <option value="">Do not link a ledger</option>
            {mine.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            {others.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {form.contractor_id && mine.length === 0 && (
        <Button
          variant="secondary"
          disabled={pending}
          className="self-start"
          onClick={() =>
            start(async () => {
              const name = form.client_business || form.client_name;
              const res = await createClientLedger(form.contractor_id, name);
              if (!res.ok) return void toast.error(res.error);
              onLedgerCreated({ id: res.data!.id, name, contractor_id: form.contractor_id });
              toast.success("Ledger created and linked");
            })
          }
        >
          <Plus className="size-4" /> Create a ledger for this client
        </Button>
      )}
    </Card>
  );
}

function ItemsStep({
  form,
  set,
  doc,
  gst,
  library,
  errors,
}: StepProps & { doc: ReturnType<typeof docFromDraft>; gst: boolean; library: LibraryItem[]; errors: Record<string, string> }) {
  const type = form.invoice_type;
  const project = type === "project";
  const product = type === "product";
  const showDiscount = !project && type !== "service";
  const showHsn = product || gst;
  const update = (i: number, patch: Partial<EditorState["items"][number]>) => set({ items: form.items.map((x, n) => (n === i ? { ...x, ...patch } : x)) });
  const move = (i: number, by: number) => {
    const next = [...form.items];
    const [row] = next.splice(i, 1);
    next.splice(i + by, 0, row);
    set({ items: next });
  };
  return (
    <div className="flex flex-col gap-3">
      {errors.items && <p className="font-medium text-out">{errors.items}</p>}
      {form.items.map((item, i) => (
        <section key={i} className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-surface p-4 ring-1 ring-inset ring-line/70">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink-2">
              {project ? "Deliverable" : "Line"} {i + 1}
            </span>
            <span className="flex gap-0.5">
              <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)} icon={ArrowUp} />
              <IconButton label="Move down" disabled={i === form.items.length - 1} onClick={() => move(i, 1)} icon={ArrowDown} />
              <IconButton label="Duplicate line" onClick={() => set({ items: [...form.items.slice(0, i + 1), { ...item }, ...form.items.slice(i + 1)] })} icon={CopyPlus} />
              <IconButton label="Delete line" disabled={form.items.length === 1} onClick={() => set({ items: form.items.filter((_, n) => n !== i) })} icon={Trash2} />
            </span>
          </div>
          <Field label={project ? "Deliverable" : product ? "Product" : "Service or item"} error={errors[`items.${i}.name`]}>
            {(p) => <Input {...p} value={item.name} onChange={(e) => update(i, { name: e.target.value })} maxLength={300} />}
          </Field>
          {project && (
            <Field label="Link or reference" optional>
              {(p) => <Input {...p} value={item.reference_url} onChange={(e) => update(i, { reference_url: e.target.value })} maxLength={300} inputMode="url" placeholder="regalimpex.in" />}
            </Field>
          )}
          <Field label="Description" optional>
            {(p) => <Textarea {...p} value={item.description} onChange={(e) => update(i, { description: e.target.value })} maxLength={4000} />}
          </Field>
          {(product || showHsn) && (
            <div className="grid grid-cols-2 gap-3">
              {product && <Field label="SKU" optional>{(p) => <Input {...p} value={item.sku} onChange={(e) => update(i, { sku: e.target.value })} maxLength={40} />}</Field>}
              {showHsn && <Field label={gst ? "HSN/SAC" : "HSN"} optional={!gst}>{(p) => <Input {...p} value={item.hsn} onChange={(e) => update(i, { hsn: e.target.value })} maxLength={12} inputMode="numeric" />}</Field>}
            </div>
          )}
          <div className={cn("grid gap-3", project ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-3")}>
            {!project && <Field label="Qty">{(p) => <Input {...p} value={item.quantity} onChange={(e) => update(i, { quantity: e.target.value })} inputMode="decimal" />}</Field>}
            {!project && <Field label="Unit" optional>{(p) => <Input {...p} value={item.unit} onChange={(e) => update(i, { unit: e.target.value })} maxLength={20} placeholder="hrs" />}</Field>}
            <Field label={project ? "Amount" : "Rate"} error={errors[`items.${i}.rate`]}>
              {(p) => <MoneyInput {...p} value={item.rate} onChange={(e) => update(i, { rate: e.target.value })} placeholder="0" />}
            </Field>
            {showDiscount && <Field label="Discount %" optional>{(p) => <Input {...p} value={item.discount_percent} onChange={(e) => update(i, { discount_percent: e.target.value })} inputMode="decimal" />}</Field>}
            {gst && (
              <Field label="GST %">
                {(p) => (
                  <Select {...p} value={item.tax_rate} onChange={(e) => update(i, { tax_rate: e.target.value })}>
                    {["0", "5", "12", "18", "28"].map((r) => (
                      <option key={r} value={r === "0" ? "" : r}>
                        {r}%
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line pt-2">
            <button
              type="button"
              className="text-[13px] font-medium text-ink-2 underline underline-offset-4"
              onClick={async () => {
                if (!item.name.trim()) return void toast.error("Name the line first");
                const res = await saveLibraryItem({ kind: "item", title: item.name, body: item.description, unit: item.unit, rate: item.rate, tax_rate: item.tax_rate, hsn: item.hsn });
                if (res.ok) toast.success("Saved for next time");
                else toast.error(res.error);
              }}
            >
              Save for reuse
            </button>
            <span className="num font-bold">{formatINR(doc.items[i]?.amount ?? 0n)}</span>
          </div>
        </section>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => set({ items: [...form.items, blankItem()] })}>
          <Plus className="size-4" /> Add {project ? "deliverable" : "item"}
        </Button>
        {library.length > 0 && (
          <select
            aria-label="Add a saved item"
            value=""
            onChange={(e) => {
              const l = library.find((x) => x.id === e.target.value);
              if (!l) return;
              const row = { ...blankItem(), name: l.title, description: l.body ?? "", unit: l.unit ?? "", rate: l.rate ? String(l.rate) : "", tax_rate: l.tax_rate ? String(l.tax_rate) : "", hsn: l.hsn ?? "" };
              const blank = form.items.length === 1 && !form.items[0].name && !form.items[0].rate;
              set({ items: blank ? [row] : [...form.items, row] });
            }}
            className="h-12 min-w-0 rounded-full bg-surface px-4 text-sm ring-1 ring-inset ring-line"
          >
            <option value="">Add a saved item…</option>
            {library.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function IconButton({ label, icon: Icon, onClick, disabled }: { label: string; icon: typeof Plus; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="inline-flex size-10 items-center justify-center rounded-full text-ink-2 hover:bg-sunken disabled:opacity-30">
      <Icon className="size-4" />
    </button>
  );
}

function TotalsStep({ form, set, doc, gst }: StepProps & { doc: ReturnType<typeof docFromDraft>; gst: boolean }) {
  return (
    <>
      <Card>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-ink-2">Discount on the whole invoice</span>
          <div className="grid grid-cols-2 gap-3">
            <Segmented
              label="Discount type"
              value={form.discount_kind}
              onChange={(v) => set({ discount_kind: v })}
              options={[
                { value: "amount", label: "₹" },
                { value: "percent", label: "%" },
              ]}
            />
            <Input aria-label="Discount" value={form.discount_value} onChange={(e) => set({ discount_value: e.target.value })} inputMode="decimal" placeholder="0" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Other charge" optional>{(p) => <Input {...p} value={form.charge_label} onChange={(e) => set({ charge_label: e.target.value })} maxLength={80} placeholder="Shipping" />}</Field>
          <Field label="Amount" optional>{(p) => <MoneyInput {...p} value={form.charge_amount} onChange={(e) => set({ charge_amount: e.target.value })} placeholder="0" />}</Field>
        </div>
        {gst && (
          <Field label="Place of supply" hint={doc.supply === "inter" ? "Different state: IGST applies" : "Same state: CGST and SGST apply"}>
            {(p) => (
              <Select {...p} value={form.place_of_supply} onChange={(e) => set({ place_of_supply: e.target.value })}>
                <option value="">Choose a state</option>
                {GST_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Checkbox label="Round the total to the nearest rupee" checked={form.round_off} onChange={(e) => set({ round_off: e.target.checked })} />
      </Card>
      <section className="rounded-[var(--radius-card)] bg-ink p-5 text-seashell">
        <dl className="flex flex-col gap-1.5 text-[15px]">
          {totalRows(doc).map((r) => (
            <div key={r.label} className="flex justify-between">
              <dt className="opacity-75">{r.label}</dt>
              <dd className="num">{r.value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="font-semibold">Grand total</span>
          <span className="num display text-3xl font-extrabold">{formatINR(doc.grand)}</span>
        </div>
        <p className="mt-1 text-[13px] opacity-75">{doc.words}</p>
      </section>
    </>
  );
}

function NotesStep({ form, set, library }: StepProps & { library: LibraryItem[] }) {
  const saved = (kind: "terms" | "notes" | "footer") => library.filter((l) => l.kind === kind);
  const pick = (field: "terms" | "notes" | "footer") => {
    const kind = field;
    return saved(kind).length > 0 ? (
      <select aria-label={`Use saved ${kind}`} value="" onChange={(e) => set({ [field]: saved(kind).find((l) => l.id === e.target.value)?.body ?? form[field] })} className="h-10 rounded-full bg-sunken px-3 text-sm">
        <option value="">Use saved…</option>
        {saved(kind).map((l) => (
          <option key={l.id} value={l.id}>
            {l.title}
          </option>
        ))}
      </select>
    ) : null;
  };
  return (
    <Card>
      <Field label="Notes" optional hint="Work completed, next steps, warranty">
        {(p) => <Textarea {...p} value={form.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={3000} />}
      </Field>
      {pick("notes")}
      <Field label="Terms and conditions" optional>
        {(p) => <Textarea {...p} value={form.terms} onChange={(e) => set({ terms: e.target.value })} maxLength={3000} />}
      </Field>
      {pick("terms")}
      <Field label="Footer" optional>
        {(p) => <Input {...p} value={form.footer} onChange={(e) => set({ footer: e.target.value })} maxLength={300} placeholder="Thank you for your business" />}
      </Field>
      {pick("footer")}
    </Card>
  );
}

function PaymentStep({ form, set, profiles }: StepProps & { profiles: PaymentProfile[] }) {
  const c = form.payment_config;
  const f = profiles.find((p) => p.id === c.profile_id);
  const patch = (p: Partial<PaymentConfig>) => set({ payment_config: { ...c, ...p } });
  return (
    <Card>
      {profiles.length === 0 ? (
        <p className="rounded-2xl bg-mustard/30 p-3 text-[15px] font-medium">
          Save your UPI ID and bank details once in{" "}
          <Link href="/invoices/settings?tab=payment" className="underline">
            Payment settings
          </Link>
          , then choose them here.
        </p>
      ) : (
        <Field label="Payment profile">
          {(p) => (
            <Select {...p} value={c.profile_id ?? ""} onChange={(e) => set({ payment_config: configFor(profiles.find((x) => x.id === e.target.value)) })}>
              <option value="">None</option>
              {profiles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <div className="flex flex-col">
        <span className="text-sm font-medium text-ink-2">Show on this invoice</span>
        {f?.upi_id && <Checkbox label={`UPI: ${f.upi_id}`} checked={Boolean(c.upi)} onChange={(e) => patch({ upi: e.target.checked })} />}
        {f?.bank_account && <Checkbox label={`Bank: ${f.bank_name ?? "account"} ending ${f.bank_account.slice(-4)}`} checked={Boolean(c.bank)} onChange={(e) => patch({ bank: e.target.checked })} />}
        <Checkbox label="Cash" checked={Boolean(c.cash)} onChange={(e) => patch({ cash: e.target.checked })} />
        <Checkbox label="Cheque" checked={Boolean(c.cheque)} onChange={(e) => patch({ cheque: e.target.checked })} />
      </div>
      {c.upi && f?.upi_qr_path && (
        <Field label="UPI QR">
          {(p) => (
            <Select {...p} value={c.qr_mode ?? "dynamic"} onChange={(e) => patch({ qr_mode: e.target.value as "dynamic" | "fixed" })}>
              <option value="dynamic">Generate for this invoice&apos;s amount</option>
              <option value="fixed">Use my saved QR image</option>
            </Select>
          )}
        </Field>
      )}
      <Field label="Other payment method" optional>
        {(p) => <Input {...p} value={c.other ?? ""} onChange={(e) => patch({ other: e.target.value })} maxLength={300} />}
      </Field>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-ink-2">On the client&apos;s page</span>
        <Checkbox label="Digital-copy QR on the PDF" checked={form.show_digital_qr} onChange={(e) => set({ show_digital_qr: e.target.checked })} />
        <Checkbox label="Let the client say they have paid" hint="You confirm it before anything changes" checked={form.allow_payment_claims} onChange={(e) => set({ allow_payment_claims: e.target.checked })} />
        <Checkbox label="Show payments received" checked={form.show_payment_history} onChange={(e) => set({ show_payment_history: e.target.checked })} />
      </div>
    </Card>
  );
}

