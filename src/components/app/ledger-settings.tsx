"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Link2, MessageCircle } from "lucide-react";
import {
  addParticipant,
  inviteCollaborator,
  revokeCollaborator,
  revokeLedgerInvitation,
  setLedgerStatus,
  updateCollaborator,
  updateLedger,
} from "@/app/(app)/actions/ledgers";
import { Field, Input, MoneyInput, Select, Textarea, Checkbox } from "@/components/ui/field";
import { DateInput } from "@/components/ui/date-picker";
import { Button } from "@/components/ui/button";
import { Avatar, Badge, Card, SectionTitle } from "@/components/ui/bits";
import { Segmented } from "@/components/ui/segmented";
import { whatsappUrl } from "./share-sheet";
import { ClientPicker, type ClientOption } from "./client-picker";
import { AddByUsername } from "./add-by-username";
import { addToLedgerByUsername } from "@/app/(app)/actions/people";
import { formatDateTime } from "@/lib/domain/dates";
import type { Collaborator, Ledger, Participant } from "@/lib/types";

const PERMS = [
  { key: "can_create", label: "Add entries", hint: "Record new money in, money out or shared expenses" },
  { key: "can_edit_own", label: "Edit their own entries", hint: "Correct entries they added themselves" },
  { key: "can_edit_all", label: "Edit any entry", hint: "Including entries you added" },
  { key: "can_view_tax", label: "See tax details", hint: "GST, TDS and bill amounts" },
] as const;

type Perms = Record<(typeof PERMS)[number]["key"], boolean> & { can_attach: boolean };

export function LedgerSettings({
  ledger,
  contractors,
  collaborators,
  invitations,
  participants,
  people,
}: {
  ledger: Ledger;
  contractors: ClientOption[];
  collaborators: Collaborator[];
  invitations: { id: string; email: string | null; participant_id: string | null; status: string; expires_at: string; created_at: string }[];
  participants: Participant[];
  /** Usernames and photos of people with a Lekha account, by user id. */
  people: Record<string, { username: string | null; photo: string | null }>;
}) {
  const router = useRouter();
  const personal = ledger.ledger_type === "personal";
  const [state, action, saving] = useActionState(updateLedger.bind(null, ledger.id), null);
  const [walletKind, setWalletKind] = useState<"cash" | "bank">(ledger.wallet_kind === "cash" ? "cash" : "bank");
  const [pending, start] = useTransition();
  const [perms, setPerms] = useState<Perms>({
    can_create: personal,
    can_edit_own: personal,
    can_edit_all: false,
    can_view_tax: false,
    can_attach: false,
  });
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);
  const active = collaborators.filter((c) => c.status === "active");

  const invite = () =>
    start(async () => {
      // Invitees join as themselves; nobody picks "who they are" in advance.
      const res = await inviteCollaborator(ledger.id, { ...perms, email: "", participant_id: "" });
      if (!res.ok) return void toast.error(res.error);
      setInviteUrl(res.data!.url);
      router.refresh();
    });

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Could not save");
      else toast.success(res.message ?? "Saved");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-10">
      <section>
        <SectionTitle className="mb-4">Details</SectionTitle>
        <Card>
          <form action={action} className="flex flex-col gap-5">
            <Field label="Name" error={err("name")}>
              {(p) => <Input {...p} name="name" defaultValue={ledger.name} required maxLength={120} />}
            </Field>
            {!personal && (
              <>
                <Field label="Client" optional>
                  {(p) => (
                    <Select {...p} name="contractor_id" defaultValue={ledger.contractor_id ?? ""}>
                      <option value="">No client</option>
                      {contractors.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <input type="hidden" name="perspective" value={ledger.perspective} />
                {ledger.perspective === "cashbook" && (
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-ink-2">Kind of wallet</span>
                    <input type="hidden" name="wallet_kind" value={walletKind} />
                    <Segmented
                      label="Kind of wallet"
                      value={walletKind}
                      onChange={setWalletKind}
                      options={[
                        { value: "bank", label: "Bank or UPI" },
                        { value: "cash", label: "Cash" },
                      ]}
                    />
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Opening balance" error={err("opening_balance")} hint="Changing it is recorded in the activity log">
                    {(p) => <MoneyInput {...p} name="opening_balance" defaultValue={ledger.opening_balance} />}
                  </Field>
                  <Field label="Opening balance date" optional>
                    {(p) => <DateInput {...p} name="opening_balance_date" defaultValue={ledger.opening_balance_date ?? ""} />}
                  </Field>
                </div>
                {ledger.ledger_type === "taxation" && (
                  <Field label="Usual GST type">
                    {(p) => (
                      <Select {...p} name="gst_mode" defaultValue={ledger.gst_mode}>
                        <option value="intra">Intra-state (CGST + SGST)</option>
                        <option value="inter">Inter-state (IGST)</option>
                      </Select>
                    )}
                  </Field>
                )}
                <Field label="Reference number" optional>
                  {(p) => <Input {...p} name="reference_no" defaultValue={ledger.reference_no ?? ""} maxLength={60} />}
                </Field>
              </>
            )}
            <Field label="Description" optional>
              {(p) => <Textarea {...p} name="description" defaultValue={ledger.description ?? ""} maxLength={500} />}
            </Field>
            {state && <p className={state.ok ? "font-medium text-in" : "font-medium text-out"}>{state.ok ? state.message : state.error}</p>}
            <Button type="submit" disabled={saving} className="self-start">
              {saving ? "Saving…" : "Save details"}
            </Button>
          </form>
        </Card>
      </section>

      {personal && !ledger.is_direct && (
        <section>
          <SectionTitle className="mb-4">People</SectionTitle>
          <Card className="flex flex-col gap-4">
            <ul className="divide-y divide-line">
              {participants.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-3">
                  <Avatar name={p.display_name} src={p.user_id ? people[p.user_id]?.photo : null} />
                  <span className="flex-1 font-medium">
                    {p.contractor_id ? (
                      <a href={`/contractors/${p.contractor_id}`} className="underline-offset-4 hover:underline">
                        {p.display_name}
                      </a>
                    ) : (
                      `${p.display_name} (you)`
                    )}
                  </span>
                  <Badge tone={p.user_id ? "in" : "neutral"}>{p.user_id ? (people[p.user_id]?.username ? `@${people[p.user_id].username}` : "On Lekha") : "Not on Lekha"}</Badge>
                </li>
              ))}
            </ul>
            <details className="rounded-2xl bg-canvas p-3">
              <summary className="cursor-pointer text-sm font-semibold">Add someone to this account</summary>
              <div className="pt-3">
                <ClientPicker
                  clients={contractors}
                  selected={[]}
                  multiple={false}
                  exclude={participants.map((p) => p.contractor_id).filter(Boolean) as string[]}
                  onChange={(ids) => ids[0] && run(() => addParticipant(ledger.id, ids[0]))}
                />
              </div>
            </details>
          </Card>
        </section>
      )}

      <section>
        <SectionTitle className="mb-2">People with access</SectionTitle>
        <p className="mb-4 max-w-prose text-[15px] text-ink-2">
          Add someone by their Lekha username and they see this {personal ? "account" : "ledger"} in Shared with me straight away. Not on Lekha yet?
          Send an invite link: they see it read-only, sign up, and join. You can remove access at any time.
        </p>
        <Card className="flex flex-col gap-5">
          {active.length > 0 && (
            <ul className="divide-y divide-line">
              {active.map((c) => (
                <li key={c.id} className="flex flex-col gap-3 py-4 first:pt-0">
                  <div className="flex items-center gap-3">
                    <Avatar name={c.display_name ?? c.email ?? "?"} src={people[c.user_id]?.photo} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{c.display_name ?? "Collaborator"}</div>
                      <div className="truncate text-[13px] text-ink-3">
                        {people[c.user_id]?.username ? `@${people[c.user_id].username}` : (c.email ?? "")} · since {formatDateTime(c.created_at)}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => revokeCollaborator(c.id, ledger.id))}>
                      Remove
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-x-5">
                    {PERMS.filter((x) => (personal ? x.key !== "can_view_tax" : true)).map((perm) => (
                      <Checkbox
                        key={perm.key}
                        label={perm.label}
                        checked={c[perm.key]}
                        disabled={pending}
                        onChange={(e) => run(() => updateCollaborator(c.id, ledger.id, { [perm.key]: e.target.checked }))}
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-4 rounded-[24px] bg-canvas p-4">
            <AddByUsername
              label="Add someone by username"
              onAdd={async (username) => {
                const res = await addToLedgerByUsername(ledger.id, username, personal ? {} : perms);
                if (!res.ok) {
                  toast.error(res.error);
                  return false;
                }
                toast.success(res.message ?? "Added");
                router.refresh();
                return true;
              }}
              extra={personal ? undefined : <PermPicker perms={perms} setPerms={setPerms} personal={personal} />}
              onInviteLink={() => setLinkOpen(true)}
            />
            {!linkOpen && (
              <button type="button" onClick={() => setLinkOpen(true)} className="self-start text-sm font-medium text-ink-2 underline underline-offset-4">
                Not on Lekha yet? Create an invite link
              </button>
            )}
          </div>

          {linkOpen && (
            <div className="flex flex-col gap-4 rounded-[24px] bg-canvas p-4">
              <h3 className="flex items-center gap-2 font-semibold">
                <Link2 className="size-4" /> Invite link
              </h3>
              <p className="text-[14px] text-ink-2">
                The link opens this {personal ? "account" : "ledger"} read-only with a sign-up button. After signing up they join as themselves.
              </p>
              <PermPicker perms={perms} setPerms={setPerms} personal={personal} />
              <Button onClick={invite} disabled={pending} className="self-start">
                {pending ? "Creating…" : "Create invite link"}
              </Button>
              {inviteUrl && (
                <div className="rounded-2xl bg-ink p-4 text-seashell">
                  <p className="break-all font-mono text-[13px]">{inviteUrl}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <a
                      href={whatsappUrl(`Hi! I’ve added you to “${ledger.name}” on Lekha. Open the link to see it, then sign up to join: ${inviteUrl}`)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-mustard font-medium text-ink"
                    >
                      <MessageCircle className="size-4" /> WhatsApp
                    </a>
                    <Button
                      variant="light"
                      size="sm"
                      className="h-11"
                      onClick={async () => {
                        await navigator.clipboard.writeText(inviteUrl);
                        toast.success("Invite link copied");
                      }}
                    >
                      <Copy className="size-4" /> Copy
                    </Button>
                  </div>
                  <p className="mt-2 text-[12px] opacity-70">Shown once. Works for one person, expires in 14 days.</p>
                </div>
              )}
            </div>
          )}

          {invitations.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-ink-2">Pending invitations</h3>
              <ul className="divide-y divide-line">
                {invitations.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-3 text-[15px]">
                    <span className="min-w-0 truncate">
                      {i.email ?? (i.participant_id ? participants.find((p) => p.id === i.participant_id)?.display_name : "Invite link")}
                      <span className="block text-[13px] text-ink-3">Expires {formatDateTime(i.expires_at)}</span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => revokeLedgerInvitation(i.id, ledger.id))}>
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </section>

      {!ledger.is_direct && (
      <section>
        <SectionTitle className="mb-4">{ledger.status === "archived" ? "Restore" : "Archive"}</SectionTitle>
        <Card className="flex flex-col items-start gap-3">
          <p className="text-[15px] text-ink-2">
            {ledger.status === "archived"
              ? "This ledger is archived. Restore it to add entries again."
              : "Archiving hides this ledger from your lists and stops new entries. Nothing is deleted: the full history, share link and exports stay available."}
          </p>
          <Button
            variant={ledger.status === "archived" ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => {
              if (ledger.status === "active" && !confirm(`Archive "${ledger.name}"? You can restore it later.`)) return;
              run(() => setLedgerStatus(ledger.id, ledger.status === "archived" ? "active" : "archived"));
            }}
          >
            {ledger.status === "archived" ? "Restore ledger" : "Archive ledger"}
          </Button>
        </Card>
      </section>
      )}
    </div>
  );
}

function PermPicker({ perms, setPerms, personal }: { perms: Perms; setPerms: (p: Perms) => void; personal: boolean }) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-ink-2">They can</legend>
      {PERMS.filter((x) => (personal ? x.key !== "can_view_tax" : true)).map((perm) => (
        <Checkbox
          key={perm.key}
          label={perm.label}
          hint={perm.hint}
          checked={perms[perm.key]}
          onChange={(e) => setPerms({ ...perms, [perm.key]: e.target.checked })}
        />
      ))}
      <p className="mt-1 text-[13px] text-ink-3">With nothing ticked they can only view.</p>
    </fieldset>
  );
}
