"use client";
import { useRouter } from "next/navigation";
import { ClientPaymentForm } from "@/components/app/client-payment";
import type { WalletOption } from "@/components/app/wallet-select";

export function PaymentPageForm(props: { clients: { id: string; name: string }[]; cashLedgers: WalletOption[]; today: string }) {
  const router = useRouter();
  return <ClientPaymentForm {...props} onDone={(id) => router.push(`/contractors/${id}`)} />;
}
