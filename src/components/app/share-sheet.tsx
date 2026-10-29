"use client";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Link2Off, MessageCircle, RefreshCw } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Select } from "@/components/ui/field";
import { Badge } from "@/components/ui/bits";
import { type ShareState, createShareLink, getShareState, revokeShareLink, updateShareLink } from "@/app/(app)/actions/ledgers";
import { formatDateTime } from "@/lib/domain/dates";

/**
 * WhatsApp click-to-chat with a prefilled message. Works on phones (app) and desktop (web). With a
 * number it opens that person's chat; without one WhatsApp asks who to send it to.
 */
export function whatsappUrl(text: string, to?: string | null) {
  return `https://wa.me/${to ?? ""}?text=${encodeURIComponent(text)}`;
}

const DEFAULTS = { show_balance: true, show_running_balance: true, show_tax: false, show_reference: false, show_counterparty: true };

export function ShareSheet({
  open,
  onClose,
  ledgerId,
  ledgerName,
  taxation,
}: {
  open: boolean;
  onClose: () => void;
  ledgerId: string;
  ledgerName: string;
  taxation: boolean;
}) {
  const [state, setState] = useState<ShareState | null>(null);
  const [options, setOptions] = useState(DEFAULTS);
  const [expiry, setExpiry] = useState("never");
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    getShareState(ledgerId).then((s) => {
      if (!alive) return;
      setState(s);
      if (s.link) setOptions({ ...DEFAULTS, ...s.link });
    });
    return () => {
      alive = false;
    };
  }, [open, ledgerId]);

  const expiresAt = () => {
    if (expiry === "never") return null;
    const d = new Date();
    d.setDate(d.getDate() + Number(expiry));
    return d.toISOString();
  };

  const refresh = async () => setState(await getShareState(ledgerId));

  const create = () =>
    start(async () => {
      const res = await createShareLink(ledgerId, { ...options, expires_at: expiresAt() });
      if (!res.ok) return void toast.error(res.error);
      toast.success(state?.link ? "New link created. The old one no longer opens." : "Share link is live");
      await refresh();
    });

  const save = (next: typeof options) => {
    setOptions(next);
    if (!state?.link) return;
    start(async () => {
      const res = await updateShareLink(state.link!.id, ledgerId, next);
      if (!res.ok) toast.error(res.error);
      else await refresh(); // the message states only what the link now shows
    });
  };

  const revoke = () =>
    start(async () => {
      if (!state?.link) return;
      const res = await revokeShareLink(state.link.id, ledgerId);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Link turned off");
      await refresh();
    });

  // Written on the server from what the recipient will see (sender, business, balance), then signed.
  const message = state?.url ? (state.message ?? `Here’s the live statement for ${ledgerName}: ${state.url}`) : "";

  return (
    <Sheet open={open} onClose={onClose} title="Share statement" description="Anyone with the link can view. Nobody can edit through it.">
      {!state ? (
        <div className="h-40 animate-pulse rounded-3xl bg-sunken" aria-label="Loading" />
      ) : (
        <div className="flex flex-col gap-5">
          {state.link && state.url ? (
            <div className="rounded-[24px] bg-tea p-5 text-seashell">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-mustard" aria-hidden />
                <span className="text-sm font-medium">Link is live</span>
                {state.link.expires_at && <Badge className="ml-auto bg-white/15 text-seashell">Expires {formatDateTime(state.link.expires_at)}</Badge>}
              </div>
              <p className="mt-3 break-all font-mono text-[13px] opacity-85">{state.url}</p>
              <p className="mt-2 text-[13px] opacity-70">
                {state.link.last_accessed_at ? `Last opened ${formatDateTime(state.link.last_accessed_at)}` : "Not opened yet"}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <a
                  href={whatsappUrl(message, state.whatsappTo)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-mustard font-medium text-ink"
                >
                  <MessageCircle className="size-5" /> WhatsApp
                </a>
                <Button
                  variant="light"
                  onClick={async () => {
                    await navigator.clipboard.writeText(state.url!);
                    toast.success("Link copied");
                  }}
                >
                  <Copy className="size-4" /> Copy link
                </Button>
              </div>
            </div>
          ) : state.link && !state.url ? (
            <div className="rounded-[24px] bg-sunken p-5 text-[15px]">
              {state.expired
                ? "This link has expired and no longer opens. Create a new one below."
                : `A link ending in …${state.link.token_hint} is active, but it cannot be shown again on this server. Create a new link to share it.`}
            </div>
          ) : (
            <div className="rounded-[24px] bg-sunken p-5 text-[15px] text-ink-2">
              Sharing is off. Create a link and send it on WhatsApp. The contractor sees new entries as soon as you add them, without
              needing a new link.
            </div>
          )}

          <fieldset className="flex flex-col">
            <legend className="mb-1 text-sm font-medium text-ink-2">What the link shows</legend>
            <Checkbox label="Balance" hint="Opening and closing balance" checked={options.show_balance} onChange={(e) => save({ ...options, show_balance: e.target.checked })} />
            <Checkbox
              label="Running balance on each row"
              checked={options.show_running_balance}
              disabled={!options.show_balance}
              onChange={(e) => save({ ...options, show_running_balance: e.target.checked })}
            />
            <Checkbox label="Payee names" checked={options.show_counterparty} onChange={(e) => save({ ...options, show_counterparty: e.target.checked })} />
            <Checkbox label="Reference numbers" checked={options.show_reference} onChange={(e) => save({ ...options, show_reference: e.target.checked })} />
            {taxation && <Checkbox label="Tax breakdown" hint="Bill amount, GST, TDS, amount after TDS" checked={options.show_tax} onChange={(e) => save({ ...options, show_tax: e.target.checked })} />}
            <p className="mt-2 text-[13px] text-ink-3">Private notes, attachments, other ledgers and your workspace details are never shown.</p>
          </fieldset>

          {!state.url && (
            <Field label="Link stops working">
              {(p) => (
                <Select {...p} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  <option value="never">Only when I turn it off</option>
                  <option value="7">After 7 days</option>
                  <option value="30">After 30 days</option>
                  <option value="90">After 90 days</option>
                </Select>
              )}
            </Field>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="lg" className="flex-1" disabled={pending} onClick={create}>
              {state.link ? (
                <>
                  <RefreshCw className="size-4" /> New link
                </>
              ) : (
                "Create share link"
              )}
            </Button>
            {state.link && (
              <Button size="lg" variant="secondary" className="flex-1" disabled={pending} onClick={revoke}>
                <Link2Off className="size-4" /> Turn off sharing
              </Button>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
