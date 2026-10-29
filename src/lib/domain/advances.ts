import { type Paise, sum, toPaise } from "./money";

/**
 * Advances are money given ahead of work. They are a receivable, not an expense.
 *   outstanding = advance − cash recovered − amount adjusted against bills
 */
export interface AdvanceRecord {
  amount: string;
  status: "active" | "void";
  given_date: string;
  expected_recovery_date: string | null;
}

export interface AllocationRecord {
  kind: "recovery" | "adjustment";
  amount: string;
  status: "active" | "void";
}

export type AdvanceStatus = "not_recovered" | "partially_recovered" | "fully_recovered" | "adjusted" | "void";

export interface AdvancePosition {
  amount: Paise;
  recovered: Paise;
  adjusted: Paise;
  outstanding: Paise;
  status: AdvanceStatus;
  overdue: boolean;
}

export function advancePosition(advance: AdvanceRecord, allocations: AllocationRecord[], today: string): AdvancePosition {
  const amount = toPaise(advance.amount);
  const active = allocations.filter((a) => a.status === "active");
  const recovered = sum(active.filter((a) => a.kind === "recovery").map((a) => toPaise(a.amount)));
  const adjusted = sum(active.filter((a) => a.kind === "adjustment").map((a) => toPaise(a.amount)));
  const outstanding = amount - recovered - adjusted;

  let status: AdvanceStatus;
  if (advance.status === "void") status = "void";
  else if (outstanding <= 0n) status = adjusted > 0n && recovered === 0n ? "adjusted" : "fully_recovered";
  else if (recovered + adjusted === 0n) status = "not_recovered";
  else status = "partially_recovered";

  const overdue =
    advance.status === "active" &&
    outstanding > 0n &&
    advance.expected_recovery_date !== null &&
    advance.expected_recovery_date < today;

  return { amount, recovered, adjusted, outstanding: advance.status === "void" ? 0n : outstanding, status, overdue };
}

/** Throws when a new allocation would take the advance below zero. Mirrors the database check. */
export function assertAllocationFits(position: AdvancePosition, amount: Paise) {
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  if (amount > position.outstanding) throw new Error("Amount is more than the outstanding advance");
}

export const ADVANCE_STATUS_LABEL: Record<AdvanceStatus, string> = {
  not_recovered: "Not recovered",
  partially_recovered: "Partly recovered",
  fully_recovered: "Recovered",
  adjusted: "Adjusted against bill",
  void: "Void",
};
