"use client";
import { useActionState } from "react";
import { saveProfile } from "@/app/(app)/actions/workspace";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

export function ProfileForm({ name, phone }: { name: string; phone: string }) {
  const [state, action, pending] = useActionState(saveProfile, null);
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);
  return (
    <form action={action} className="flex flex-col gap-5">
      <Field label="Your name" hint="Used in your greeting and shown to people you share ledgers with." error={err("full_name")}>
        {(p) => <Input {...p} name="full_name" defaultValue={name} autoComplete="name" required maxLength={120} />}
      </Field>
      <Field label="Mobile number" hint="Private to you." error={err("phone")}>
        {(p) => (
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[16px] text-ink-3">
              +91
            </span>
            <Input
              {...p}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              defaultValue={phone.replace(/^\+91/, "")}
              placeholder="98765 43210"
              required
              maxLength={16}
              className="pl-14"
            />
          </div>
        )}
      </Field>
      {state && <p className={state.ok ? "font-medium text-in" : "font-medium text-out"}>{state.ok ? state.message : !state.fieldErrors && state.error}</p>}
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}
