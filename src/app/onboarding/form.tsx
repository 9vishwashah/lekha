"use client";
import { useActionState } from "react";
import { createWorkspace } from "@/app/(app)/actions/workspace";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

export function OnboardingForm({ suggestion }: { suggestion: string }) {
  const [state, action, pending] = useActionState(createWorkspace, null);
  return (
    <form action={action} className="flex flex-col gap-6">
      <Field
        label="Workspace name"
        hint="Usually your business or firm name. You can change it later."
        error={state && !state.ok ? (state.fieldErrors?.name ?? state.error) : undefined}
      >
        {(p) => <Input {...p} name="name" defaultValue={suggestion} required maxLength={120} autoFocus />}
      </Field>
      <div className="rounded-3xl bg-surface p-5 text-sm text-ink-2 ring-1 ring-inset ring-line">
        Defaults for India: rupees, Asia/Kolkata time, April–March financial year, GST 18% and TDS 1% as starting rates. Every rate is
        editable per entry.
      </div>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}
