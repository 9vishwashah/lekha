"use client";
import { useRouter } from "next/navigation";
import { ClientPaymentForm } from "@/components/app/client-payment";

export function PaymentPageForm(props: { clients: { id: string; name: string }[]; cashLedgers: { id: string; name: string }[]; today: string }) {
  const router = useRouter();
  return <ClientPaymentForm {...props} onDone={(id) => router.push(`/contractors/${id}`)} />;
}
