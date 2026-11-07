"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { classifyEntry } from "@/app/(app)/actions/ledgers";
import { Select } from "@/components/ui/field";
import { NATURES } from "@/lib/types";

export function ClassifyEntry({ id, direction }: { id: string; direction: "in" | "out" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Select
      aria-label="What was this?"
      className="w-44"
      defaultValue=""
      disabled={pending}
      onChange={(e) => {
        const nature = e.target.value;
        if (!nature) return;
        start(async () => {
          const res = await classifyEntry(id, { nature });
          if (!res.ok) return void toast.error(res.error);
          toast.success(res.message ?? "Saved");
          router.refresh();
        });
      }}
    >
      <option value="">What was this?</option>
      {NATURES.filter((n) => n.direction === direction || n.direction === "both").map((n) => (
        <option key={n.value} value={n.value}>
          {n.label}
        </option>
      ))}
    </Select>
  );
}
