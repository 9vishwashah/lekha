"use client";
import { useActionState } from "react";
import { createWorkspace } from "@/app/(app)/actions/workspace";
import { Card } from "@/components/ui/bits";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

export function NewWorkspace() {
  const [state, action, pending] = useActionState(createWorkspace, null);
  return (
    <Card>
      <form action={action} className="flex flex-col gap-4">
        <p className="text-[15px] text-ink-2">Each workspace is a separate, private book with its own contractors, ledgers and members.</p>
        <Field label="New workspace name" error={state && !state.ok ? state.error : undefined}>
          {(p) => <Input {...p} name="name" required maxLength={120} />}
        </Field>
        <Button type="submit" variant="secondary" disabled={pending} className="self-start">
          Create workspace
        </Button>
      </form>
    </Card>
  );
}
