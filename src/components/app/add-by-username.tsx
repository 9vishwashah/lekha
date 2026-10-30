"use client";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { LoaderCircle, Link2, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { findPerson } from "@/app/(app)/actions/workspace";
import { cn } from "@/lib/cn";

type Found = { username: string; fullName: string; photo: string | null };
const FORMAT = /^[a-z0-9][a-z0-9_.]{2,19}$/;
const clean = (s: string) => s.trim().replace(/^@/, "").toLowerCase();

/**
 * Type someone's exact @username. If they are on Lekha you see their name and photo and add them in
 * one tap; if nobody has that username you are offered an invite link instead. There is no
 * browsing or partial search: only the exact username finds a person.
 */
export function AddByUsername({
  label = "Add by username",
  actionLabel = "Add",
  onAdd,
  extra,
  onInviteLink,
  inviteLabel = "Send an invite link instead",
  disabled,
}: {
  label?: string;
  actionLabel?: string;
  onAdd: (username: string) => Promise<boolean>;
  /** Options shown with a match, such as a role or permissions. */
  extra?: ReactNode;
  /** Offered when nobody has that username. */
  onInviteLink?: () => void;
  inviteLabel?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<{ name: string; person: Found | null } | null>(null);
  const [pending, start] = useTransition();
  const v = clean(value);
  const valid = FORMAT.test(v);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const t = setTimeout(async () => {
      const person = await findPerson(v);
      if (alive) setResult({ name: v, person });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [v, valid]);

  const current = valid && result?.name === v ? result : null;
  const searching = valid && !current;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink-2">{label}</span>
        <span className="relative">
          <span aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[16px] font-medium text-ink-3">
            @
          </span>
          <input
            value={value}
            onChange={(e) => setValue(clean(e.target.value).replace(/[^a-z0-9_.]/g, ""))}
            placeholder="username"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            disabled={disabled}
            className="h-12 w-full rounded-[var(--radius-field)] bg-white pl-9 pr-11 text-[16px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-ink"
          />
          {searching && <LoaderCircle className="absolute right-4 top-1/2 size-4 -translate-y-1/2 animate-spin text-ink-3" aria-label="Looking up" />}
        </span>
      </label>

      {current?.person && (
        <div className="flex flex-col gap-3 rounded-[24px] bg-white p-4 ring-1 ring-inset ring-line">
          <div className="flex items-center gap-3">
            <Avatar name={current.person.fullName} src={current.person.photo} className="size-12" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{current.person.fullName}</div>
              <div className="truncate text-[13px] text-ink-3">@{current.person.username} · on Lekha</div>
            </div>
          </div>
          {extra}
          <Button
            disabled={pending || disabled}
            onClick={() =>
              start(async () => {
                if (await onAdd(current.person!.username)) {
                  setValue("");
                  setResult(null);
                }
              })
            }
          >
            <UserPlus className="size-4" /> {pending ? "Adding…" : `${actionLabel} ${current.person.fullName.split(" ")[0]}`}
          </Button>
        </div>
      )}

      {current && !current.person && (
        <div className="flex flex-col gap-3 rounded-[24px] bg-canvas p-4 text-[15px]">
          <p>
            Nobody on Lekha is <span className="font-semibold">@{current.name}</span>.
            {onInviteLink && " Send them an invite link: they see the ledger, sign up, and join."}
          </p>
          {onInviteLink && (
            <Button variant="secondary" className={cn("self-start")} onClick={onInviteLink}>
              <Link2 className="size-4" /> {inviteLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
