"use client";
import { useOptimistic, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { switchWorkspace } from "@/app/(app)/actions/workspace";
import { Menu, MenuItem } from "@/components/ui/menu";
import { cn } from "@/lib/cn";

const TILES = ["bg-mustard text-ink", "bg-lavender text-ink", "bg-tea text-seashell", "bg-pink text-ink", "bg-sky text-ink", "bg-tangerine text-ink"];

/** Each workspace keeps the same solid colour, picked from its id. */
const tileOf = (id: string) => TILES[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % TILES.length];

function Tile({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-2xl text-[15px] font-extrabold", tileOf(id), className)}>
      {name.trim().charAt(0).toUpperCase() || "W"}
    </span>
  );
}

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

/**
 * The workspace (business) you are in, and the switch between them. The new name shows at once;
 * the page then reloads with that workspace's data. A detail page (one ledger, one client) belongs
 * to the old workspace, so switching from there goes to Home. The last option starts a new business.
 */
export function WorkspaceSwitcher({
  current,
  options,
  compact = false,
}: {
  current: string;
  options: { id: string; name: string; role: string }[];
  /** Phone header: smaller, name only. */
  compact?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic(current);
  const active = options.find((o) => o.id === shown) ?? options[0];

  const pick = (id: string, close: () => void) => {
    close();
    if (id === shown) return;
    start(async () => {
      setShown(id);
      await switchWorkspace(id);
      if (pathname.split("/").filter(Boolean).length > 1) router.push("/dashboard");
      else router.refresh();
    });
  };

  return (
    <Menu
      label="Switch workspace"
      align={compact ? "end" : "start"}
      buttonClassName={cn(
        "flex w-full min-w-0 items-center gap-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink",
        compact ? "h-11 max-w-[11rem] rounded-full bg-surface pl-1.5 pr-3 ring-1 ring-inset ring-line/70" : "rounded-[22px] bg-surface p-2 pr-3 ring-1 ring-inset ring-line/70 hover:bg-white",
        pending && "opacity-70",
      )}
      button={
        <>
          <Tile id={active.id} name={active.name} className={compact ? "size-8 rounded-xl text-[13px]" : undefined} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold leading-tight">{active.name}</span>
            {!compact && <span className="block truncate text-[12px] text-ink-3">{ROLE[active.role] ?? active.role} · workspace</span>}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-ink-3" />
        </>
      }
    >
      {(close) => (
        <>
          <p className="px-3 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Your workspaces</p>
          {options.map((o) => (
            <MenuItem key={o.id} onSelect={() => pick(o.id, close)}>
              <Tile id={o.id} name={o.name} className="size-9 rounded-xl text-sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{o.name}</span>
                <span className="block text-[12px] font-normal text-ink-3">{ROLE[o.role] ?? o.role}</span>
              </span>
              {o.id === shown && <Check className="size-4 shrink-0" />}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-line" />
          <MenuItem href="/settings#new-workspace" onSelect={close}>
            <span className="inline-flex size-9 items-center justify-center rounded-xl bg-sunken">
              <Plus className="size-4" />
            </span>
            Add a business
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
