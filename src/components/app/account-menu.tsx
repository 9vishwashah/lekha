"use client";
import { useClerk } from "@clerk/nextjs";
import { LogOut, ShieldCheck, UserRound } from "lucide-react";
import { Avatar } from "@/components/ui/bits";
import { Menu, MenuItem } from "@/components/ui/menu";
import { cn } from "@/lib/cn";

/**
 * You: your photo (or initials) and the name you entered, instead of the sign-in provider's
 * default badge. Opens your profile, account security and sign out.
 */
export function AccountMenu({
  name,
  username,
  photo,
  compact = false,
}: {
  name: string;
  username: string | null;
  photo: string | null;
  /** Phone header: just the photo. */
  compact?: boolean;
}) {
  const { signOut } = useClerk();
  return (
    <Menu
      label="Your account"
      side={compact ? "bottom" : "top"}
      align={compact ? "end" : "start"}
      buttonClassName={cn(
        "flex items-center gap-3 rounded-full text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink",
        compact ? "p-0.5" : "w-full p-1.5 pr-4 hover:bg-sunken",
      )}
      button={
        <>
          <Avatar name={name} src={photo} tone="ink" className={compact ? "size-9 text-[13px]" : "size-10"} />
          {!compact && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold">{name}</span>
              {username && <span className="block truncate text-[13px] text-ink-3">@{username}</span>}
            </span>
          )}
        </>
      }
    >
      {(close) => (
        <>
          <div className="flex items-center gap-3 px-3 pb-3 pt-2">
            <Avatar name={name} src={photo} tone="ink" className="size-12" />
            <div className="min-w-0">
              <div className="truncate font-semibold">{name}</div>
              {username && <div className="truncate text-[13px] text-ink-3">@{username}</div>}
            </div>
          </div>
          <MenuItem href="/settings#profile" onSelect={close}>
            <UserRound className="size-[18px]" /> Profile & photo
          </MenuItem>
          <MenuItem href="/settings/account" onSelect={close}>
            <ShieldCheck className="size-[18px]" /> Sign-in & security
          </MenuItem>
          <MenuItem danger onSelect={() => signOut({ redirectUrl: "/" })}>
            <LogOut className="size-[18px]" /> Sign out
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
