"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { switchWorkspace } from "@/app/(app)/actions/workspace";

export function WorkspaceSwitcher({
  current,
  options,
}: {
  current: string;
  options: { id: string; name: string; role: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (options.length < 2) {
    return <div className="truncate text-sm font-semibold">{options[0]?.name}</div>;
  }
  return (
    <label className="block min-w-0">
      <span className="sr-only">Workspace</span>
      <select
        value={current}
        disabled={pending}
        onChange={(e) =>
          start(async () => {
            await switchWorkspace(e.target.value);
            router.refresh();
          })
        }
        className="h-10 w-full max-w-56 truncate rounded-full bg-transparent pr-6 text-sm font-semibold focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
