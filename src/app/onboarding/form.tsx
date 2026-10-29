"use client";
import { useActionState, useState } from "react";
import { createWorkspace } from "@/app/(app)/actions/workspace";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

const suggestWorkspace = (name: string) => {
  const first = name.trim().split(/\s+/)[0];
  return first ? `${first}${first.toLowerCase().endsWith("s") ? "’" : "’s"} business` : "";
};

export function OnboardingForm({
  defaultName,
  defaultPhone,
  next,
  askWorkspace,
}: {
  defaultName: string;
  defaultPhone: string;
  /** The invitation to return to; the workspace becomes optional. */
  next: string | null;
  askWorkspace: boolean;
}) {
  const [state, action, pending] = useActionState(createWorkspace, null);
  const [name, setName] = useState(defaultName);
  // From an invitation the workspace starts empty: joining someone's ledger doesn't need one.
  const [workspace, setWorkspace] = useState(next ? "" : suggestWorkspace(defaultName));
  const [touched, setTouched] = useState(false);
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  return (
    <form action={action} className="flex flex-col gap-6">
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Your name" hint="Shown in your greeting, and to people you share ledgers with." error={err("full_name")}>
        {(p) => (
          <Input
            {...p}
            name="full_name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!touched && !next) setWorkspace(suggestWorkspace(e.target.value));
            }}
            autoComplete="name"
            required
            maxLength={120}
            autoFocus
          />
        )}
      </Field>
      <Field label="Mobile number" hint="Private to you. Not shown to anyone you share with." error={err("phone")}>
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
              defaultValue={defaultPhone.replace(/^\+91/, "")}
              placeholder="98765 43210"
              required
              maxLength={16}
              className="pl-14"
            />
          </div>
        )}
      </Field>
      {askWorkspace && (
        <Field
          label="Workspace name"
          optional={Boolean(next)}
          hint={next ? "Only if you also want your own books. You can create one later in Settings." : "Usually your business or firm name. You can change it later."}
          error={err("name")}
        >
          {(p) => (
            <Input
              {...p}
              name="name"
              value={workspace}
              onChange={(e) => {
                setTouched(true);
                setWorkspace(e.target.value);
              }}
              required={!next}
              maxLength={120}
            />
          )}
        </Field>
      )}
      {askWorkspace && !next && (
        <div className="rounded-3xl bg-surface p-5 text-sm text-ink-2 ring-1 ring-inset ring-line">
          Defaults for India: rupees, Asia/Kolkata time, April–March financial year, GST 18% and TDS 1% as starting rates. Every rate is
          editable per entry.
        </div>
      )}
      {state && !state.ok && !state.fieldErrors && <p className="font-medium text-out">{state.error}</p>}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Setting up…" : next ? "Continue to invitation" : "Continue"}
      </Button>
    </form>
  );
}
