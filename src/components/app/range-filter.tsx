"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { DateRangeInput } from "@/components/ui/date-picker";
import { cn } from "@/lib/cn";

/** Custom date range for a page; navigates as soon as the range is complete. */
export function RangeFilter({
  basePath,
  from,
  to,
  extra = {},
  className,
}: {
  basePath: string;
  from?: string;
  to?: string;
  extra?: Record<string, string>;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <DateRangeInput
      className={cn("w-full sm:w-auto", pending && "opacity-60", className)}
      label="Custom dates"
      from={from}
      to={to}
      onChange={(r) =>
        start(() => {
          const qs = new URLSearchParams({ ...extra, ...(r.from && { from: r.from }), ...(r.to && { to: r.to }) });
          if (!r.from && !r.to) qs.set("period", "month");
          router.push(`${basePath}?${qs}`, { scroll: false });
        })
      }
    />
  );
}
