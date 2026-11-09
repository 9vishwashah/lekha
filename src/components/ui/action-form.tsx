"use client";
import { type ComponentProps, useTransition } from "react";

/**
 * A form that sends its fields to a server action without clearing itself.
 *
 * A plain <form action={...}> in React 19 resets every uncontrolled field once the action finishes,
 * back to the value the page first rendered with. A dropdown chosen and saved would snap back to
 * the old choice, and an error would wipe what was typed. This submits the same FormData through a
 * transition instead, so the fields keep exactly what the person entered.
 */
export function ActionForm({
  action,
  children,
  ...props
}: Omit<ComponentProps<"form">, "action" | "onSubmit"> & { action: (form: FormData) => unknown }) {
  const [, start] = useTransition();
  return (
    <form
      {...props}
      onSubmit={(e) => {
        e.preventDefault();
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
        const data = new FormData(e.currentTarget, submitter);
        start(() => {
          action(data);
        });
      }}
    >
      {children}
    </form>
  );
}
