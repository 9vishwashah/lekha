"use client";
import { useState } from "react";
import { Field, Select } from "@/components/ui/field";
import { walletForMode } from "@/lib/domain/books";

export interface WalletOption {
  id: string;
  name: string;
  kind: "cash" | "bank" | null;
}

/**
 * Which wallet the money went through. It follows the payment mode (cash to cash, everything else
 * to the bank) until the person picks one themselves, and it stays visible either way, so nothing
 * lands anywhere without being shown first.
 */
export function useWallet(wallets: WalletOption[], mode: string, initial = "") {
  const [picked, setPicked] = useState<string | null>(initial || null);
  return { value: picked ?? walletForMode(wallets, mode), setValue: setPicked };
}

export function WalletSelect({
  wallets,
  value,
  onChange,
  label,
  name,
  hint,
}: {
  wallets: WalletOption[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  name?: string;
  hint?: string;
}) {
  if (wallets.length === 0) return null;
  return (
    <Field label={label} optional hint={hint}>
      {(p) => (
        <Select {...p} name={name} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not tracked</option>
          {wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
