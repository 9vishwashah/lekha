"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setCategoryHead } from "@/app/(app)/actions/ledgers";
import { Segmented } from "@/components/ui/segmented";

/** Which expense categories are direct costs of the trade (gross profit) and which are indirect. */
export function CategoryHeads({ categories }: { categories: { id: string; name: string; head: "direct" | "indirect" }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <ul className="divide-y divide-line rounded-[var(--radius-card)] bg-surface ring-1 ring-inset ring-line/70">
      {categories.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <span className="font-medium">{c.name}</span>
          <Segmented
            label={`Head for ${c.name}`}
            value={c.head}
            onChange={(head) =>
              !pending &&
              start(async () => {
                const res = await setCategoryHead(c.id, head);
                if (!res.ok) return void toast.error(res.error);
                toast.success(res.message ?? "Saved");
                router.refresh();
              })
            }
            options={[
              { value: "direct", label: "Direct" },
              { value: "indirect", label: "Indirect" },
            ]}
          />
        </li>
      ))}
    </ul>
  );
}
