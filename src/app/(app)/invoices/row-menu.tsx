"use client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, CircleDollarSign, CopyPlus, Download, Eye, Link2, MessageCircle, MoreVertical, Pencil, XCircle } from "lucide-react";
import { Menu, MenuItem } from "@/components/ui/menu";
import { duplicateInvoice, getInvoiceUrl, markShared } from "@/app/(app)/actions/invoices";
import { invoiceShareMessage } from "@/lib/domain/invoice";
import { toPaise } from "@/lib/domain/money";
import { whatsappLink, whatsappNumber } from "@/lib/whatsapp";

export interface ShareInfo {
  clientName: string;
  invoiceNo: string;
  total: string | number;
  dueDate: string | null;
  phone: string | null;
  proforma: boolean;
  business: string;
}

/** Opens WhatsApp with the invoice message. The link is fetched on tap; it is never in the page. */
export async function shareOnWhatsApp(id: string, s: ShareInfo) {
  // Open first: browsers block a window opened after an await.
  const win = window.open("about:blank", "_blank");
  const url = await getInvoiceUrl(id);
  if (!url) {
    win?.close();
    return void toast.error("This invoice has no live link. Create a new one from its page.");
  }
  const text = invoiceShareMessage({ clientName: s.clientName, business: s.business, invoiceNo: s.invoiceNo, total: toPaise(s.total), dueDate: s.dueDate, url, proforma: s.proforma });
  const href = whatsappLink(text, whatsappNumber(s.phone));
  if (win) win.location.href = href;
  else window.location.href = href;
  await markShared(id);
}

export function InvoiceRowMenu({ id, status, canWrite, canPay, message }: { id: string; status: string; canWrite: boolean; canPay: boolean; message: ShareInfo }) {
  const router = useRouter();
  const issued = status === "issued";
  return (
    <Menu
      label="Invoice actions"
      align="end"
      className="shrink-0 self-center pr-1.5"
      buttonClassName="inline-flex size-11 items-center justify-center rounded-full hover:bg-sunken"
      button={<MoreVertical className="size-5" />}
    >
      {(close) => (
        <>
          <MenuItem href={`/invoices/${id}`} onSelect={close}>
            <Eye className="size-[18px]" /> View
          </MenuItem>
          {canWrite && status === "draft" && (
            <MenuItem href={`/invoices/${id}/edit`} onSelect={close}>
              <Pencil className="size-[18px]" /> Edit
            </MenuItem>
          )}
          {canWrite && issued && (
            <MenuItem
              onSelect={() => {
                close();
                void shareOnWhatsApp(id, message);
              }}
            >
              <MessageCircle className="size-[18px]" /> Share on WhatsApp
            </MenuItem>
          )}
          {canWrite && issued && (
            <MenuItem
              onSelect={async () => {
                close();
                const url = await getInvoiceUrl(id);
                if (!url) return void toast.error("This invoice has no live link");
                await navigator.clipboard.writeText(url);
                toast.success("Link copied");
              }}
            >
              <Link2 className="size-[18px]" /> Copy invoice link
            </MenuItem>
          )}
          <a role="menuitem" href={`/api/invoices/${id}/pdf`} onClick={close} className="flex min-h-12 items-center gap-3 rounded-2xl px-3 text-[15px] font-medium hover:bg-sunken">
            <Download className="size-[18px]" /> Download PDF
          </a>
          {canWrite && canPay && (
            <MenuItem href={`/invoices/${id}?do=pay`} onSelect={close}>
              <CircleDollarSign className="size-[18px]" /> Record payment
            </MenuItem>
          )}
          {canWrite && canPay && (
            <MenuItem href={`/invoices/${id}?do=remind`} onSelect={close}>
              <Bell className="size-[18px]" /> Send reminder
            </MenuItem>
          )}
          {canWrite && (
            <MenuItem
              onSelect={async () => {
                close();
                const res = await duplicateInvoice(id);
                if (!res.ok) return void toast.error(res.error);
                toast.success(res.message ?? "Duplicated");
                router.push(`/invoices/${res.data!.id}/edit`);
              }}
            >
              <CopyPlus className="size-[18px]" /> Duplicate
            </MenuItem>
          )}
          {canWrite && issued && (
            <MenuItem danger href={`/invoices/${id}?do=cancel`} onSelect={close}>
              <XCircle className="size-[18px]" /> Cancel invoice
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
}

