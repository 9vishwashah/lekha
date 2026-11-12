"use client";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { setEmailPrefs } from "@/app/(app)/actions/email";

/** Which emails Lekha sends you. Client reminders and statements are set on each client's page. */
export function EmailPrefs({ newActivity, monthly, ready }: { newActivity: boolean; monthly: boolean; ready: boolean }) {
  const [, start] = useTransition();
  const [prefs, set] = useOptimistic({ newActivity, monthly }, (s, patch: Partial<{ newActivity: boolean; monthly: boolean }>) => ({ ...s, ...patch }));

  const toggle = (key: "newActivity" | "monthly") =>
    start(async () => {
      const next = !prefs[key];
      set({ [key]: next });
      const res = await setEmailPrefs({ [key]: next });
      if (!res.ok) toast.error(res.error);
    });

  const row = (key: "newActivity" | "monthly", title: string, hint: string) => (
    <div className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="text-[14px] text-ink-2">{hint}</div>
      </div>
      <Button size="sm" variant={prefs[key] ? "primary" : "secondary"} onClick={() => toggle(key)} aria-pressed={prefs[key]}>
        {prefs[key] ? "On" : "Off"}
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col divide-y divide-line">
      {!ready && <p className="pb-3 text-[14px] text-ink-3">Email sending is not set up on the server yet; these settings apply once it is.</p>}
      {row("newActivity", "New activity", "A daily email (9 AM) when people add entries, expenses or payments with you, or confirm a statement.")}
      {row("monthly", "Monthly summary", "On the 1st: who owes you and whom you owe, for each workspace you own.")}
      <p className="pt-3 text-[13px] text-ink-3">Payment reminders and monthly statements for your clients are on each client’s page.</p>
    </div>
  );
}
