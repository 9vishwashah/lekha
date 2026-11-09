"use client";
import { ActionForm } from "@/components/ui/action-form";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { addMemberByUsername, inviteMember, removeMember, revokeInvitation, setMemberRole, updateWorkspace } from "@/app/(app)/actions/workspace";
import { AddByUsername } from "@/components/app/add-by-username";
import { Field, Input, Select } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Avatar, Badge, Card } from "@/components/ui/bits";
import { formatDateTime } from "@/lib/domain/dates";
import type { Member, Workspace } from "@/lib/types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function WorkspaceSettingsForm({ workspace, canEdit }: { workspace: Workspace; canEdit: boolean }) {
  const [state, action, pending] = useActionState(updateWorkspace, null);
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);
  return (
    <ActionForm action={action} className="flex flex-col gap-5">
      <fieldset disabled={!canEdit} className="flex flex-col gap-5">
        <Field label="Workspace name" error={err("name")}>
          {(p) => <Input {...p} name="name" defaultValue={workspace.name} required maxLength={120} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Financial year starts in">
            {(p) => (
              <Select {...p} name="fy_start_month" defaultValue={String(workspace.fy_start_month)}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Usual GST type">
            {(p) => (
              <Select {...p} name="default_gst_mode" defaultValue={workspace.default_gst_mode}>
                <option value="intra">Intra-state (CGST + SGST)</option>
                <option value="inter">Inter-state (IGST)</option>
              </Select>
            )}
          </Field>
          <Field label="Starting GST rate %" error={err("default_gst_rate")} hint="Pre-fills new bills only">
            {(p) => <Input {...p} name="default_gst_rate" inputMode="decimal" defaultValue={String(Number(workspace.default_gst_rate))} />}
          </Field>
          <Field label="Starting TDS rate %" error={err("default_tds_rate")}>
            {(p) => <Input {...p} name="default_tds_rate" inputMode="decimal" defaultValue={String(Number(workspace.default_tds_rate))} />}
          </Field>
          <Field label="TDS usually on" className="sm:col-span-2">
            {(p) => (
              <Select {...p} name="default_tds_base" defaultValue={workspace.default_tds_base}>
                <option value="taxable">Taxable amount (before GST)</option>
                <option value="gross">Amount including GST</option>
              </Select>
            )}
          </Field>
        </div>
        <p className="text-[13px] text-ink-3">
          Currency ₹ INR · time zone {workspace.timezone}. Changing default rates never alters bills already recorded: each bill keeps the rates it was saved
          with.
        </p>
      </fieldset>
      {state && <p className={state.ok ? "font-medium text-in" : "font-medium text-out"}>{state.ok ? state.message : state.error}</p>}
      {canEdit && (
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Saving…" : "Save settings"}
        </Button>
      )}
    </ActionForm>
  );
}

export function MembersPanel({
  members,
  invites,
  me,
  isAdmin,
  people,
}: {
  members: Member[];
  invites: { id: string; email: string | null; role: string | null; expires_at: string }[];
  me: string;
  isAdmin: boolean;
  /** Profile photos and usernames by user id. */
  people: Record<string, { username: string | null; photo: string | null }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, action, inviting] = useActionState(inviteMember, null);
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState("member");
  const [linkOpen, setLinkOpen] = useState(false);
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message ?? "Saved");
      else toast.error(res.error ?? "Could not save");
      router.refresh();
    });

  return (
    <Card className="flex flex-col gap-5">
      <ul className="divide-y divide-line">
        {members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
            <Avatar name={m.display_name ?? m.email ?? "?"} src={people[m.user_id]?.photo} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">
                {m.display_name ?? "Member"}
                {m.user_id === me && <span className="font-normal text-ink-3"> (you)</span>}
              </div>
              <div className="truncate text-[13px] text-ink-3">{people[m.user_id]?.username ? `@${people[m.user_id].username}` : m.email}</div>
            </div>
            {isAdmin && m.role !== "owner" && m.user_id !== me ? (
              <>
                <label className="sr-only" htmlFor={`role-${m.id}`}>
                  Role for {m.display_name}
                </label>
                <select
                  id={`role-${m.id}`}
                  defaultValue={m.role}
                  disabled={pending}
                  onChange={(e) => run(() => setMemberRole(m.id, e.target.value))}
                  className="h-10 rounded-full bg-white px-3 text-sm ring-1 ring-inset ring-line"
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => confirm(`Remove ${m.display_name ?? "this member"} from the workspace?`) && run(() => removeMember(m.id))}
                >
                  Remove
                </Button>
              </>
            ) : (
              <Badge tone={m.role === "owner" ? "ink" : "neutral"}>{m.role}</Badge>
            )}
          </li>
        ))}
      </ul>

      {isAdmin && (
        <div className="flex flex-col gap-4 rounded-[24px] bg-canvas p-4">
          <h3 className="font-semibold">Add someone to the workspace</h3>
          <AddByUsername
            onAdd={async (username) => {
              const res = await addMemberByUsername(username, role);
              if (!res.ok) {
                toast.error(res.error);
                return false;
              }
              toast.success(res.message ?? "Added");
              router.refresh();
              return true;
            }}
            extra={
              <Field label="Role">
                {(p) => (
                  <Select {...p} value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value="admin">Admin: manages members and settings</option>
                    <option value="member">Member: adds and edits entries</option>
                    <option value="viewer">Viewer: can only look</option>
                  </Select>
                )}
              </Field>
            }
            onInviteLink={() => setLinkOpen(true)}
          />
          {!linkOpen && (
            <button type="button" onClick={() => setLinkOpen(true)} className="self-start text-sm font-medium text-ink-2 underline underline-offset-4">
              Not on Lekha yet? Create an invite link
            </button>
          )}
        </div>
      )}

      {isAdmin && linkOpen && (
        <ActionForm action={action} className="flex flex-col gap-3 rounded-[24px] bg-canvas p-4">
          <h3 className="font-semibold">Invite link</h3>
          <p className="text-[14px] text-ink-2">For someone not on Lekha yet. They sign up from the link and join with this role.</p>
          <Field label="Role">
            {(p) => (
              <Select {...p} name="role" defaultValue={role}>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </Select>
            )}
          </Field>
          <Button type="submit" disabled={inviting} className="self-start">
            {inviting ? "Creating…" : "Create invite link"}
          </Button>
          {state?.ok && state.data && (
            <div className="rounded-2xl bg-ink p-4 text-seashell">
              <p className="break-all font-mono text-[13px]">{state.data.url}</p>
              <Button
                variant="light"
                size="sm"
                className="mt-3"
                onClick={async () => {
                  await navigator.clipboard.writeText(state.data!.url);
                  setCopied(true);
                }}
              >
                <Copy className="size-4" /> {copied ? "Copied" : "Copy link"}
              </Button>
              <p className="mt-2 text-[12px] opacity-70">Shown once. One person can use it, within 14 days.</p>
            </div>
          )}
          {state && !state.ok && <p className="font-medium text-out">{state.error}</p>}
        </ActionForm>
      )}

      {invites.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-ink-2">Pending</h3>
          <ul className="divide-y divide-line">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2.5 text-[15px]">
                <span>
                  {i.email ?? "Link invitation"} · {i.role}
                  <span className="block text-[13px] text-ink-3">Expires {formatDateTime(i.expires_at)}</span>
                </span>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => revokeInvitation(i.id))}>
                  Cancel
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
