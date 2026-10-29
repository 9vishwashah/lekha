"use client";
import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveContractor } from "@/app/(app)/actions/records";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";

interface Existing {
  id: string;
  name: string;
  phone: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (s: string | null) => (s ?? "").replace(/\D/g, "").slice(-10);

/**
 * Add or edit a contractor. Similar names or the same phone number raise a warning; nothing is
 * merged automatically.
 */
export function ContractorForm({
  contractor,
  existing,
  taxIds,
  onDone,
}: {
  contractor?: {
    id: string;
    name: string;
    business_name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    notes: string | null;
    kind: "business" | "personal";
  };
  existing: Existing[];
  taxIds?: { gstin: string | null; pan: string | null } | null;
  onDone?: (id: string) => void;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveContractor.bind(null, contractor?.id ?? null), null);
  const [name, setName] = useState(contractor?.name ?? "");
  const [phone, setPhone] = useState(contractor?.phone ?? "");
  const [kind, setKind] = useState<"business" | "personal">(contractor?.kind ?? "business");
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message ?? "Saved");
      router.refresh();
      onDone?.(state.data!.id);
    }
  }, [state, router, onDone]);

  const similar = useMemo(() => {
    const n = norm(name);
    const p = digits(phone);
    if (n.length < 3 && p.length < 10) return [];
    return existing.filter(
      (e) => e.id !== contractor?.id && ((n.length >= 3 && (norm(e.name).includes(n) || n.includes(norm(e.name)))) || (p.length === 10 && digits(e.phone) === p)),
    );
  }, [name, phone, existing, contractor?.id]);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="kind" value={kind} />
      <Segmented
        label="Type of account"
        value={kind}
        onChange={setKind}
        options={[
          { value: "business", label: "Client or contractor" },
          { value: "personal", label: "Friend or family" },
        ]}
      />
      <Field label="Name" error={err("name")}>
        {(p) => <Input {...p} name="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} autoComplete="off" />}
      </Field>
      {similar.length > 0 && (
        <div role="status" className="rounded-2xl bg-[#f7e9b8] p-3 text-sm text-[#5b4708]">
          Possibly already added: {similar.map((s) => s.name).join(", ")}. Check before saving a duplicate. You can merge them later from
          their page.
        </div>
      )}
      {kind === "business" && (
      <Field label="Business name" optional>
        {(p) => <Input {...p} name="business_name" defaultValue={contractor?.business_name ?? ""} maxLength={160} />}
      </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone" optional error={err("phone")}>
          {(p) => <Input {...p} name="phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} />}
        </Field>
        <Field label="Email" optional error={err("email")}>
          {(p) => <Input {...p} name="email" type="email" defaultValue={contractor?.email ?? ""} maxLength={200} />}
        </Field>
      </div>
      <Field label="Address" optional>
        {(p) => <Textarea {...p} name="address" defaultValue={contractor?.address ?? ""} maxLength={500} />}
      </Field>
      {kind === "business" && (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="GSTIN" optional error={err("gstin")} hint="Visible only to members who can edit">
          {(p) => <Input {...p} name="gstin" defaultValue={taxIds?.gstin ?? ""} maxLength={15} autoCapitalize="characters" className="uppercase" />}
        </Field>
        <Field label="PAN" optional error={err("pan")}>
          {(p) => <Input {...p} name="pan" defaultValue={taxIds?.pan ?? ""} maxLength={10} autoCapitalize="characters" className="uppercase" />}
        </Field>
      </div>
      )}
      <Field label="Notes" optional>
        {(p) => <Textarea {...p} name="notes" defaultValue={contractor?.notes ?? ""} maxLength={2000} />}
      </Field>
      {state && !state.ok && !state.fieldErrors && <p className="font-medium text-out">{state.error}</p>}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Saving…" : contractor ? "Save" : "Add client"}
      </Button>
    </form>
  );
}
