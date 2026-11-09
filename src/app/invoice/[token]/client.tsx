"use client";
import { ActionForm } from "@/components/ui/action-form";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, Download, FileCheck2, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, MoneyInput, Select, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { PAYMENT_MODES } from "@/lib/types";

/** Counts a real person opening the page. Link-preview crawlers do not run this. */
export function ViewBeacon({ token }: { token: string }) {
  useEffect(() => {
    fetch(`/api/invoice/${token}/viewed`, { method: "POST", keepalive: true }).catch(() => {});
  }, [token]);
  return null;
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-ink-3">{label}</div>
        <div className="num break-all text-[15px] font-semibold">{value}</div>
      </div>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-sunken"
      >
        {copied ? <Check className="size-4 text-in" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/** Generates the PDF on the server, so a tap shows progress until the file arrives. */
export function DownloadButton({ href, label, primary }: { href: string; label: string; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const cls = primary
    ? "inline-flex h-14 w-full items-center justify-center gap-2 rounded-full bg-ink px-5 text-[15px] font-semibold text-surface"
    : "inline-flex h-14 w-full items-center justify-center gap-2 rounded-full bg-surface px-5 text-[15px] font-semibold ring-1 ring-inset ring-line";
  return (
    <a
      href={href}
      className={cls}
      onClick={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          const res = await fetch(href);
          if (!res.ok) throw new Error();
          const blob = await res.blob();
          const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "invoice";
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch {
          toast.error("That could not be downloaded. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : primary ? <Download className="size-4" /> : <FileCheck2 className="size-4" />}
      {busy ? "Preparing…" : label}
    </a>
  );
}

/** "I've made a payment": a note for the business to verify. It never marks anything paid. */
export function ClaimButton({ token, balance, today }: { token: string; balance: string; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const submit = (form: FormData) =>
    start(async () => {
      setError(null);
      const res = await fetch(`/api/invoice/${token}/claim`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setError(body.error ?? "That could not be sent. Try again.");
      setDone(true);
      router.refresh();
    });

  return (
    <>
      <Button size="lg" variant="secondary" className="h-14 w-full" onClick={() => setOpen(true)}>
        I’ve made a payment
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={done ? "Thank you" : "Tell them you’ve paid"} description={done ? undefined : "The business checks this against their account, then updates the invoice."}>
        {done ? (
          <div className="flex flex-col gap-4 pb-2">
            <p className="text-[15px] text-ink-2">Your note has been sent. The balance updates once the business confirms the payment.</p>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </div>
        ) : (
          <ActionForm action={submit} className="flex flex-col gap-4 pb-2">
            <Field label="Amount paid">{(p) => <MoneyInput {...p} name="amount" big defaultValue={balance} required />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date paid">{(p) => <Input {...p} name="paid_on" type="date" defaultValue={today} max={today} required />}</Field>
              <Field label="Paid by" optional>
                {(p) => (
                  <Select {...p} name="mode" defaultValue="upi">
                    {PAYMENT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="UTR or transaction ID" optional>{(p) => <Input {...p} name="reference" maxLength={80} autoComplete="off" />}</Field>
            <Field label="Screenshot" optional hint="JPG, PNG or PDF under 4 MB">
              {(p) => <input {...p} name="proof" type="file" accept="image/png,image/jpeg,application/pdf" className="text-[15px]" />}
            </Field>
            <Field label="Message" optional>{(p) => <Textarea {...p} name="message" maxLength={500} />}</Field>
            {error && (
              <p role="alert" className="rounded-2xl bg-[#f6dcda] p-3 font-medium text-out">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Sending…" : "Send to the business"}
            </Button>
          </ActionForm>
        )}
      </Sheet>
    </>
  );
}
