"use client";
/* eslint-disable @next/next/no-img-element -- uploaded brand images */
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { archivePaymentProfile, clearBrandImage, deleteLibraryItem, saveInvoiceSettings, saveLibraryItem, savePaymentProfile, uploadBrandImage } from "@/app/(app)/actions/invoices";
import { TEMPLATES, formatInvoiceNumber, fyLabel } from "@/lib/domain/invoice";
import { GST_STATES } from "@/lib/domain/india";
import { todayISO } from "@/lib/domain/dates";
import { brandUrl, docFromDraft } from "@/lib/invoices/doc";
import { blankDraft, blankItem } from "@/lib/invoices/editor";
import type { InvoiceSettings, LibraryItem, PaymentProfile } from "@/lib/server/invoices";
import { cn } from "@/lib/cn";
import { InvoiceSheet } from "@/components/app/invoice/invoice-sheet";
import { ScaledSheet } from "@/components/app/invoice/scaled-sheet";

const TABS = [
  { key: "business", label: "Business" },
  { key: "look", label: "Look" },
  { key: "numbers", label: "Numbering" },
  { key: "payment", label: "Payment" },
  { key: "saved", label: "Saved content" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** Shrinks a logo in the browser and keeps it PNG or JPG, the two formats a PDF can embed. */
async function shrink(file: File, max: number): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return new File([blob!], "image.png", { type: "image/png" });
}

function ImagePicker({ label, field, path, disabled, onPath }: { label: string; field: "logo_path" | "signature_path" | "stamp_path" | "qr"; path: string | null | undefined; disabled: boolean; onPath?: (path: string | null) => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState(path ?? null);
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-inset ring-line">
        {current ? <img src={brandUrl(current) ?? ""} alt="" className="size-full object-contain" /> : <span className="text-[12px] text-ink-3">None</span>}
      </div>
      <div className="flex flex-col items-start gap-1">
        <span className="text-[15px] font-semibold">{label}</span>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="secondary" disabled={disabled || pending} onClick={() => input.current?.click()}>
            {pending ? "Uploading…" : current ? "Change" : "Upload"}
          </Button>
          {current && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || pending}
              onClick={() =>
                start(async () => {
                  if (field !== "qr") {
                    const res = await clearBrandImage(field);
                    if (!res.ok) return void toast.error(res.error);
                  }
                  setCurrent(null);
                  onPath?.(null);
                  router.refresh();
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          start(async () => {
            try {
              const form = new FormData();
              form.set("field", field);
              form.set("file", await shrink(file, 900));
              const res = await uploadBrandImage(form);
              if (!res.ok) return void toast.error(res.error);
              setCurrent(res.data!.path);
              onPath?.(res.data!.path);
              router.refresh();
            } catch {
              toast.error("That image could not be read. Try a PNG or JPG.");
            }
          });
        }}
      />
    </div>
  );
}

export function InvoiceSettingsScreen({ settings, profiles, library, canEdit, initialTab, fyStart }: { settings: InvoiceSettings; profiles: PaymentProfile[]; library: LibraryItem[]; canEdit: boolean; initialTab?: string; fyStart: number }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.key === initialTab) ? (initialTab as Tab) : "business");
  const [form, setForm] = useState(settings);
  const [pending, start] = useTransition();
  const set = (patch: Partial<InvoiceSettings>) => setForm((f) => ({ ...f, ...patch }));
  const str = (k: keyof InvoiceSettings) => (form[k] as string | null | undefined) ?? "";

  const sample = useMemo(() => {
    const d = blankDraft("service", form, [], todayISO());
    return docFromDraft(
      { ...d, template: form.template ?? "modern", client_name: "Client Name", client_address: "Client address", title: "Sample invoice", items: [{ ...blankItem(), name: "Professional services", description: "A short description of the work.", rate: "25000" }], terms: form.default_terms ?? "Payment due within 14 days." },
      form,
      { upi: { id: "you@upi", payee: form.business_name ?? "", dynamic: true } },
      formatInvoiceNumber({ format: form.number_format, prefix: form.number_prefix, padding: form.number_padding }, fyLabel(todayISO(), fyStart), todayISO(), form.number_start),
    );
  }, [form, fyStart]);

  const save = () =>
    start(async () => {
      const res = await saveInvoiceSettings({
        business_name: str("business_name"), email: str("email"), phone: str("phone"), address: str("address"), website: str("website"),
        gst_registered: Boolean(form.gst_registered), gstin: str("gstin"), pan: str("pan"), state_code: str("state_code"),
        signatory_name: str("signatory_name"), signatory_title: str("signatory_title"),
        template: (form.template ?? "modern") as "modern", brand_color: form.brand_color ?? "#1d1d1b", accent_color: form.accent_color ?? "#eac119",
        logo_position: (form.logo_position ?? "left") as "left",
        number_prefix: form.number_prefix, proforma_prefix: form.proforma_prefix, number_format: form.number_format, number_padding: form.number_padding,
        number_start: form.number_start, number_reset: form.number_reset, default_due_days: form.default_due_days,
        default_payment_terms: str("default_payment_terms"), default_terms: str("default_terms"), default_notes: str("default_notes"), default_footer: str("default_footer"),
        default_profile_id: form.default_profile_id ?? "",
        show_digital_qr: form.show_digital_qr, round_off: form.round_off, allow_payment_claims: form.allow_payment_claims, show_payment_history: form.show_payment_history,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Saved");
      router.refresh();
    });

  const number = formatInvoiceNumber({ format: form.number_format, prefix: form.number_prefix, padding: form.number_padding }, fyLabel(todayISO(), fyStart), todayISO(), form.number_start);

  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
      <div className="flex min-w-0 flex-col gap-4">
        <nav aria-label="Settings sections" className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0" data-no-swipe>
          {TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => setTab(t.key)} aria-current={tab === t.key ? "true" : undefined} className={cn("h-10 shrink-0 rounded-full px-4 text-sm font-medium", tab === t.key ? "bg-ink text-surface" : "bg-sunken text-ink-2")}>
              {t.label}
            </button>
          ))}
        </nav>

        <fieldset disabled={!canEdit} className="contents">
          {tab === "business" && (
            <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-4 ring-1 ring-inset ring-line/70 sm:p-5">
              <ImagePicker label="Logo" field="logo_path" path={settings.logo_path} disabled={!canEdit} />
              <Field label="Business name">{(p) => <Input {...p} value={str("business_name")} onChange={(e) => set({ business_name: e.target.value })} maxLength={160} />}</Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Email" optional>{(p) => <Input {...p} type="email" value={str("email")} onChange={(e) => set({ email: e.target.value })} maxLength={200} />}</Field>
                <Field label="Phone" optional>{(p) => <Input {...p} type="tel" value={str("phone")} onChange={(e) => set({ phone: e.target.value })} maxLength={40} />}</Field>
              </div>
              <Field label="Business address" optional>{(p) => <Textarea {...p} value={str("address")} onChange={(e) => set({ address: e.target.value })} maxLength={500} />}</Field>
              <Field label="Website" optional>{(p) => <Input {...p} value={str("website")} onChange={(e) => set({ website: e.target.value })} maxLength={200} />}</Field>
              <Checkbox label="This business is registered for GST" hint="Unlocks GST tax invoices. GST is never added otherwise." checked={Boolean(form.gst_registered)} onChange={(e) => set({ gst_registered: e.target.checked })} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="GSTIN" optional={!form.gst_registered}>{(p) => <Input {...p} value={str("gstin")} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} maxLength={15} />}</Field>
                <Field label="PAN" optional>{(p) => <Input {...p} value={str("pan")} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} maxLength={10} />}</Field>
              </div>
              <Field label="State" optional hint="Decides CGST + SGST or IGST">
                {(p) => (
                  <Select {...p} value={str("state_code")} onChange={(e) => set({ state_code: e.target.value })}>
                    <option value="">Not set</option>
                    {GST_STATES.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Authorized signatory" optional>{(p) => <Input {...p} value={str("signatory_name")} onChange={(e) => set({ signatory_name: e.target.value })} maxLength={120} />}</Field>
                <Field label="Designation" optional>{(p) => <Input {...p} value={str("signatory_title")} onChange={(e) => set({ signatory_title: e.target.value })} maxLength={120} />}</Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <ImagePicker label="Signature" field="signature_path" path={settings.signature_path} disabled={!canEdit} />
                <ImagePicker label="Stamp or seal" field="stamp_path" path={settings.stamp_path} disabled={!canEdit} />
              </div>
            </section>
          )}

          {tab === "look" && (
            <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-4 ring-1 ring-inset ring-line/70 sm:p-5">
              <div className="grid gap-2 sm:grid-cols-2">
                {TEMPLATES.map((t) => (
                  <button key={t.value} type="button" onClick={() => set({ template: t.value })} aria-pressed={form.template === t.value} className={cn("rounded-2xl p-4 text-left ring-1 ring-inset", form.template === t.value ? "bg-ink text-surface ring-ink" : "bg-white ring-line")}>
                    <span className="block font-semibold">{t.label}</span>
                    <span className="block text-[13px] opacity-75">{t.hint}</span>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Brand colour">{(p) => <input {...p} type="color" value={form.brand_color ?? "#1d1d1b"} onChange={(e) => set({ brand_color: e.target.value })} className="h-12 w-full rounded-[var(--radius-field)] bg-white p-1 ring-1 ring-inset ring-line" />}</Field>
                <Field label="Accent colour">{(p) => <input {...p} type="color" value={form.accent_color ?? "#eac119"} onChange={(e) => set({ accent_color: e.target.value })} className="h-12 w-full rounded-[var(--radius-field)] bg-white p-1 ring-1 ring-inset ring-line" />}</Field>
              </div>
              <Field label="Logo position">
                {(p) => (
                  <Select {...p} value={form.logo_position ?? "left"} onChange={(e) => set({ logo_position: e.target.value })}>
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                  </Select>
                )}
              </Field>
              <Checkbox label="Digital-copy QR on PDFs" checked={form.show_digital_qr} onChange={(e) => set({ show_digital_qr: e.target.checked })} />
              <Checkbox label="Round totals to the nearest rupee" checked={form.round_off} onChange={(e) => set({ round_off: e.target.checked })} />
            </section>
          )}

          {tab === "numbers" && (
            <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-4 ring-1 ring-inset ring-line/70 sm:p-5">
              <p className="rounded-2xl bg-sunken p-4 text-[15px]">
                Your next invoice: <span className="font-bold">{number}</span>
              </p>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Invoice prefix">{(p) => <Input {...p} value={form.number_prefix} onChange={(e) => set({ number_prefix: e.target.value })} maxLength={20} />}</Field>
                <Field label="Proforma prefix">{(p) => <Input {...p} value={form.proforma_prefix} onChange={(e) => set({ proforma_prefix: e.target.value })} maxLength={20} />}</Field>
              </div>
              <Field label="Format" hint="Use {PREFIX}, {FY}, {YYYY}, {MM} and {SEQ}. {SEQ} is required.">{(p) => <Input {...p} value={form.number_format} onChange={(e) => set({ number_format: e.target.value })} maxLength={60} />}</Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Digits">{(p) => <Input {...p} type="number" min={1} max={8} value={form.number_padding} onChange={(e) => set({ number_padding: Number(e.target.value) || 1 })} />}</Field>
                <Field label="Start from" hint="For a series that has not begun">{(p) => <Input {...p} type="number" min={1} value={form.number_start} onChange={(e) => set({ number_start: Number(e.target.value) || 1 })} />}</Field>
              </div>
              <Field label="When a new financial year starts">
                {(p) => (
                  <Select {...p} value={form.number_reset} onChange={(e) => set({ number_reset: e.target.value as "yearly" })}>
                    <option value="yearly">Restart the numbering</option>
                    <option value="never">Keep counting</option>
                  </Select>
                )}
              </Field>
              <Field label="Default days to pay">{(p) => <Input {...p} type="number" min={0} max={365} value={form.default_due_days} onChange={(e) => set({ default_due_days: Number(e.target.value) || 0 })} />}</Field>
              <Field label="Default payment terms" optional>{(p) => <Input {...p} value={str("default_payment_terms")} onChange={(e) => set({ default_payment_terms: e.target.value })} maxLength={200} />}</Field>
              <Field label="Default terms and conditions" optional>{(p) => <Textarea {...p} value={str("default_terms")} onChange={(e) => set({ default_terms: e.target.value })} maxLength={3000} />}</Field>
              <Field label="Default notes" optional>{(p) => <Textarea {...p} value={str("default_notes")} onChange={(e) => set({ default_notes: e.target.value })} maxLength={3000} />}</Field>
              <Field label="Default footer" optional>{(p) => <Input {...p} value={str("default_footer")} onChange={(e) => set({ default_footer: e.target.value })} maxLength={300} />}</Field>
            </section>
          )}

          {tab === "payment" && (
            <PaymentTab profiles={profiles} defaultId={form.default_profile_id} canEdit={canEdit} onDefault={(id) => set({ default_profile_id: id })}>
              <Checkbox label="Let clients say they have paid" hint="You confirm it before any balance changes" checked={form.allow_payment_claims} onChange={(e) => set({ allow_payment_claims: e.target.checked })} />
              <Checkbox label="Show clients the payments received" checked={form.show_payment_history} onChange={(e) => set({ show_payment_history: e.target.checked })} />
            </PaymentTab>
          )}

          {tab === "saved" && <SavedTab library={library} />}
        </fieldset>

        {canEdit && tab !== "saved" && (
          <Button size="lg" disabled={pending} onClick={save} className="self-start">
            {pending ? "Saving…" : "Save settings"}
          </Button>
        )}
      </div>

      <aside className="sticky top-6 hidden max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-2xl ring-1 ring-line lg:block" aria-label="Preview">
        <ScaledSheet>
          <InvoiceSheet doc={sample} />
        </ScaledSheet>
      </aside>
      {tab === "look" && (
        <div className="overflow-hidden rounded-2xl ring-1 ring-line lg:hidden">
          <ScaledSheet>
            <InvoiceSheet doc={sample} />
          </ScaledSheet>
        </div>
      )}
    </div>
  );
}

const EMPTY = { label: "", upi_id: "", upi_payee: "", upi_number: "", upi_qr_path: null as string | null, bank_holder: "", bank_name: "", bank_branch: "", bank_account: "", bank_ifsc: "", instructions: "" };

function PaymentTab({ profiles, defaultId, canEdit, onDefault, children }: { profiles: PaymentProfile[]; defaultId: string | null; canEdit: boolean; onDefault: (id: string | null) => void; children: React.ReactNode }) {
  const router = useRouter();
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: string }) | null>(null);
  const [pending, start] = useTransition();
  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-4 ring-1 ring-inset ring-line/70 sm:p-5">
      <p className="text-[14px] text-ink-2">Save each UPI ID or bank account once, then pick one on any invoice. Only what you select appears on that invoice.</p>
      <ul className="flex flex-col gap-2">
        {profiles.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-inset ring-line">
            <input type="radio" name="default-profile" aria-label={`Use ${p.label} by default`} checked={defaultId === p.id} onChange={() => onDefault(p.id)} className="size-5 accent-[#1d1d1b]" />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEdit({ ...EMPTY, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v ?? (k === "upi_qr_path" ? null : "")])) })}>
              <span className="block font-semibold">{p.label}</span>
              <span className="block truncate text-[13px] text-ink-3">{[p.upi_id, p.bank_account && `${p.bank_name ?? "Bank"} ····${p.bank_account.slice(-4)}`].filter(Boolean).join(" · ") || "No details yet"}</span>
            </button>
            {canEdit && (
              <button
                type="button"
                aria-label={`Remove ${p.label}`}
                disabled={pending}
                className="inline-flex size-10 items-center justify-center rounded-full hover:bg-sunken"
                onClick={() =>
                  window.confirm(`Remove ${p.label}?`) &&
                  start(async () => {
                    const res = await archivePaymentProfile(p.id);
                    if (!res.ok) return void toast.error(res.error);
                    toast.success(res.message ?? "Removed");
                    router.refresh();
                  })
                }
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <Button variant="secondary" className="self-start" onClick={() => setEdit({ ...EMPTY })}>
          <Plus className="size-4" /> Add payment profile
        </Button>
      )}
      {children}
      {edit && (
        <Sheet
          open
          onClose={() => setEdit(null)}
          title={edit.id ? "Edit payment profile" : "New payment profile"}
          description="Shown to clients only on invoices where you select it."
          footer={
            <Button
              size="lg"
              className="w-full"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await savePaymentProfile(edit);
                  if (!res.ok) return void toast.error(res.error);
                  toast.success(res.message ?? "Saved");
                  setEdit(null);
                  router.refresh();
                })
              }
            >
              Save profile
            </Button>
          }
        >
          <div className="flex flex-col gap-4 pb-1">
            <Field label="Name">{(p) => <Input {...p} value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} maxLength={60} placeholder="HDFC current account" />}</Field>
            <h3 className="font-semibold">UPI</h3>
            <Field label="UPI ID" optional>{(p) => <Input {...p} value={edit.upi_id} onChange={(e) => setEdit({ ...edit, upi_id: e.target.value })} maxLength={120} placeholder="name@bank" autoCapitalize="none" />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Payee name" optional>{(p) => <Input {...p} value={edit.upi_payee} onChange={(e) => setEdit({ ...edit, upi_payee: e.target.value })} maxLength={120} />}</Field>
              <Field label="UPI number" optional>{(p) => <Input {...p} value={edit.upi_number} onChange={(e) => setEdit({ ...edit, upi_number: e.target.value })} maxLength={20} />}</Field>
            </div>
            <ImagePicker label="Your fixed QR (optional)" field="qr" path={edit.upi_qr_path} disabled={false} onPath={(path) => setEdit((x) => (x ? { ...x, upi_qr_path: path } : x))} />
            <h3 className="font-semibold">Bank</h3>
            <Field label="Account holder" optional>{(p) => <Input {...p} value={edit.bank_holder} onChange={(e) => setEdit({ ...edit, bank_holder: e.target.value })} maxLength={160} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Bank" optional>{(p) => <Input {...p} value={edit.bank_name} onChange={(e) => setEdit({ ...edit, bank_name: e.target.value })} maxLength={160} />}</Field>
              <Field label="Branch" optional>{(p) => <Input {...p} value={edit.bank_branch} onChange={(e) => setEdit({ ...edit, bank_branch: e.target.value })} maxLength={200} />}</Field>
              <Field label="Account number" optional>{(p) => <Input {...p} value={edit.bank_account} onChange={(e) => setEdit({ ...edit, bank_account: e.target.value })} maxLength={40} autoComplete="off" />}</Field>
              <Field label="IFSC" optional>{(p) => <Input {...p} value={edit.bank_ifsc} onChange={(e) => setEdit({ ...edit, bank_ifsc: e.target.value.toUpperCase() })} maxLength={11} autoComplete="off" />}</Field>
            </div>
            <Field label="Payment instructions" optional>{(p) => <Textarea {...p} value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} maxLength={1000} />}</Field>
          </div>
        </Sheet>
      )}
    </section>
  );
}

const KIND_LABEL = { item: "Item or service", terms: "Terms", notes: "Note", footer: "Footer", payment: "Payment instruction" };

function SavedTab({ library }: { library: LibraryItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<LibraryItem["kind"]>("terms");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [rate, setRate] = useState("");
  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-4 ring-1 ring-inset ring-line/70 sm:p-5">
      <p className="text-[14px] text-ink-2">Things you use on every invoice: a service line, your terms, a note. Pick them in the editor instead of typing again.</p>
      <ul className="flex flex-col divide-y divide-line">
        {library.map((l) => (
          <li key={l.id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{l.title}</div>
              <div className="truncate text-[13px] text-ink-3">
                {KIND_LABEL[l.kind]}
                {l.body ? ` · ${l.body}` : ""}
              </div>
            </div>
            <button
              type="button"
              aria-label={`Remove ${l.title}`}
              disabled={pending}
              className="inline-flex size-10 items-center justify-center rounded-full hover:bg-sunken"
              onClick={() =>
                start(async () => {
                  const res = await deleteLibraryItem(l.id);
                  if (!res.ok) return void toast.error(res.error);
                  router.refresh();
                })
              }
            >
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3 rounded-2xl bg-canvas p-4">
        <Field label="Type">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as LibraryItem["kind"])}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Name">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />}</Field>
        <Field label={kind === "item" ? "Description" : "Text"} optional={kind === "item"}>{(p) => <Textarea {...p} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />}</Field>
        {kind === "item" && <Field label="Rate" optional>{(p) => <MoneyInput {...p} value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>}
        <Button
          variant="secondary"
          className="self-start"
          disabled={pending || !title.trim()}
          onClick={() =>
            start(async () => {
              const res = await saveLibraryItem({ kind, title, body, rate });
              if (!res.ok) return void toast.error(res.error);
              setTitle("");
              setBody("");
              setRate("");
              router.refresh();
            })
          }
        >
          Save
        </Button>
      </div>
    </section>
  );
}
