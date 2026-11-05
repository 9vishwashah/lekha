"use client";
/* eslint-disable @next/next/no-img-element -- a local preview of the chosen file */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, MoneyInput, Select } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { saveDraft } from "@/app/(app)/actions/invoices";
import { tryPaise } from "@/lib/domain/money";
import { blankItem, configFor, type EditorState } from "@/lib/invoices/editor";
import type { PaymentProfile } from "@/lib/server/invoices";

const MAX = 4 * 1024 * 1024;

export function UploadForm({
  initial,
  profiles,
  clients,
  ledgers,
}: {
  initial: EditorState;
  profiles: PaymentProfile[];
  clients: { id: string; name: string; business_name: string | null; phone: string | null; email: string | null; address: string | null }[];
  ledgers: { id: string; name: string; contractor_id: string | null }[];
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [form, setForm] = useState({ ...initial, save_client: true });
  const [amount, setAmount] = useState("");
  const [visible, setVisible] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const set = (p: Partial<EditorState>) => setForm((f) => ({ ...f, ...p }));

  // A local preview: nothing leaves the device until "Save and review".
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const send = (id: string, f: File) =>
    new Promise<string | null>((resolve) => {
      const data = new FormData();
      data.set("file", f);
      data.set("role", "original");
      data.set("client_visible", String(visible));
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/invoices/${id}/files`);
      xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => resolve(xhr.status < 400 ? null : ((JSON.parse(xhr.responseText || "{}") as { error?: string }).error ?? "The file could not be uploaded"));
      xhr.onerror = () => resolve("Upload failed. Check your connection.");
      xhr.send(data);
    });

  const submit = async () => {
    if (!file) return void toast.error("Choose your invoice file");
    if (!form.client_name.trim()) return void toast.error("Add the client");
    if (!form.invoice_no.trim()) return void toast.error("Enter the number printed on your invoice");
    const paise = tryPaise(amount);
    if (!paise || paise <= 0n) return void toast.error("Enter the invoice total");
    setProgress(0);
    const res = await saveDraft({
      ...form,
      source: "uploaded",
      invoice_type: "custom",
      // One summary line: the details live in the uploaded document, which stays the official copy.
      items: [{ ...blankItem(), name: form.title || `As per invoice ${form.invoice_no}`, rate: amount }],
      discount_value: "",
      charge_amount: "",
      round_off: false,
      payment_config: form.payment_config as Record<string, unknown>,
    });
    if (!res.ok) {
      setProgress(null);
      return void toast.error(res.error);
    }
    const id = res.data!.id;
    const error = await send(id, file);
    setProgress(null);
    if (error) {
      toast.error(error);
      return router.push(`/invoices/${id}`);
    }
    toast.success("Saved as a draft. Check it, then issue it.");
    router.push(`/invoices/${id}`);
  };

  const pick = (id: string) => {
    const c = clients.find((x) => x.id === id);
    if (!c) return set({ contractor_id: "", save_client: true });
    set({ contractor_id: c.id, save_client: false, client_name: c.name, client_business: c.business_name ?? "", client_phone: c.phone ?? "", client_email: c.email ?? "", client_address: c.address ?? "", ledger_id: ledgers.find((l) => l.contractor_id === c.id)?.id ?? form.ledger_id });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-3xl bg-sunken p-4 text-[14px]">
        Want a Lekha invoice with this file attached as a supporting document instead?{" "}
        <Link href="/invoices/new" className="font-semibold underline underline-offset-4">
          Create the invoice
        </Link>{" "}
        and attach it on the invoice page.
      </p>

      <button type="button" onClick={() => input.current?.click()} className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 border-dashed border-line bg-surface p-6 text-center">
        <FileUp className="size-6" />
        <span className="font-semibold">{file ? file.name : "Choose your invoice"}</span>
        <span className="text-[13px] text-ink-3">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB. Tap to choose another.` : "PDF, Word (.docx), PNG or JPG, up to 4 MB"}</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".pdf,.docx,.png,.jpg,.jpeg"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (f.size > MAX) return void toast.error("Keep the file under 4 MB");
          setFile(f);
          setPreview(URL.createObjectURL(f));
        }}
      />
      {file && preview && file.type.startsWith("image/") && <img src={preview} alt="Preview of your invoice" className="max-h-96 rounded-2xl object-contain ring-1 ring-line" />}
      {file && preview && file.type === "application/pdf" && (
        <a href={preview} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold underline underline-offset-4">
          Preview the PDF
        </a>
      )}

      <section className="flex flex-col gap-4 rounded-[var(--radius-card)] bg-surface p-4 ring-1 ring-inset ring-line/70 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Invoice number" hint="As printed on your invoice">{(p) => <Input {...p} value={form.invoice_no} onChange={(e) => set({ invoice_no: e.target.value })} maxLength={60} autoComplete="off" />}</Field>
          <Field label="Total amount" hint="Including any tax">{(p) => <MoneyInput {...p} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />}</Field>
          <Field label="Invoice date">{(p) => <DateInput {...p} value={form.invoice_date} onChange={(v) => set({ invoice_date: v })} />}</Field>
          <Field label="Due date" optional>{(p) => <DateInput {...p} value={form.due_date} onChange={(v) => set({ due_date: v })} />}</Field>
        </div>
        <Field label="Title" optional>{(p) => <Input {...p} value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} />}</Field>
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
          <Field label="Client name">{(p) => <Input {...p} value={form.client_name} onChange={(e) => set({ client_name: e.target.value })} maxLength={160} autoComplete="off" />}</Field>
          <Field label="WhatsApp number" optional>{(p) => <Input {...p} type="tel" value={form.client_phone} onChange={(e) => set({ client_phone: e.target.value })} maxLength={20} autoComplete="off" />}</Field>
        </div>
        {!form.contractor_id && <Checkbox label="Save to Client Accounts" checked={form.save_client} onChange={(e) => set({ save_client: e.target.checked })} />}
        <Field label="Ledger" optional hint="Issuing adds the amount owed here; payments reduce it.">
          {(p) => (
            <Select {...p} value={form.ledger_id} onChange={(e) => set({ ledger_id: e.target.value })}>
              <option value="">Do not link a ledger</option>
              {ledgers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {profiles.length > 0 && (
          <Field label="Payment details to show" optional>
            {(p) => (
              <Select {...p} value={form.payment_config.profile_id ?? ""} onChange={(e) => set({ payment_config: configFor(profiles.find((x) => x.id === e.target.value)) })}>
                <option value="">None (use what is on your invoice)</option>
                {profiles.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Checkbox label="My client can download this document" hint="Only tick this if the file holds nothing private" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
      </section>

      <Button size="lg" disabled={progress !== null} onClick={() => void submit()}>
        {progress !== null ? `Uploading ${progress}%` : "Save and review"}
      </Button>
    </div>
  );
}
