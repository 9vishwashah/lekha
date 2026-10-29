import { FilterChips } from "./pending-nav";
import { RangeFilter } from "./range-filter";
import { PERIOD_LABEL, type PeriodKey, periodRange, todayISO } from "@/lib/domain/dates";

const KEYS: PeriodKey[] = ["today", "week", "month", "fy", "all"];
const SHORT: Record<PeriodKey, string> = { today: "Today", week: "Week", month: "Month", fy: "FY", all: "All", custom: "Custom" };

export function resolvePeriod(
  params: { period?: string; from?: string; to?: string },
  fyStartMonth: number,
  fallback: PeriodKey = "month",
) {
  const key = (params.from || params.to ? "custom" : (params.period as PeriodKey)) || fallback;
  const valid: PeriodKey = [...KEYS, "custom"].includes(key) ? key : fallback;
  const today = todayISO();
  const range = periodRange(valid, today, fyStartMonth, { from: params.from, to: params.to });
  return { key: valid, range, today, label: PERIOD_LABEL[valid] };
}

/** Period chips plus a custom range. The chips are real links, so they also work without JS. */
export function PeriodTabs({
  basePath,
  active,
  from,
  to,
  extra = {},
}: {
  basePath: string;
  active: PeriodKey;
  from?: string;
  to?: string;
  extra?: Record<string, string>;
}) {
  const qs = (p: Record<string, string>) => `${basePath}?${new URLSearchParams({ ...extra, ...p }).toString()}`;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <FilterChips
        label="Period"
        active={active}
        items={KEYS.map((k) => ({
          key: k,
          href: qs({ period: k }),
          label: (
            <>
              <span className="sm:hidden">{SHORT[k]}</span>
              <span className="hidden sm:inline">{PERIOD_LABEL[k]}</span>
            </>
          ),
        }))}
      />
      <RangeFilter basePath={basePath} from={from} to={to} extra={extra} />
    </div>
  );
}
