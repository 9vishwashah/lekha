"use client";
import { useOptimistic, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { switchWorkspace } from "@/app/(app)/actions/workspace";
import { cn } from "@/lib/cn";

const ADD = "__add";

/**
 * Switches the active workspace (business). The new name shows at once; the page then reloads with
 * that workspace's data. A detail page (one ledger, one client) belongs to the old workspace, so
 * switching from there goes to Home instead. The last option starts a new business.
 */
export function WorkspaceSwitcher({
  current,
  options,
}: {
  current: string;
  options: { id: string; name: string; role: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic(current);
  return (
    <label className="block min-w-0">
      <span className="sr-only">Workspace</span>
      <select
        value={shown}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value;
          if (id === ADD) return router.push("/settings#new-workspace");
          start(async () => {
            setShown(id);
            await switchWorkspace(id);
            if (pathname.split("/").filter(Boolean).length > 1) router.push("/dashboard");
            else router.refresh();
          });
        }}
        className={cn("h-10 w-full max-w-56 truncate rounded-full bg-transparent pr-6 text-sm font-semibold focus:outline-none", pending && "opacity-60")}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        <option value={ADD}>+ Add a business</option>
      </select>
    </label>
  );
}
