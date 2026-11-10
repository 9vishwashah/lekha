"use client";
import { IntentLink } from "@/components/app/intent-link";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BookOpenCheck, ArrowLeftRight, BookOpen, ChartColumn, FileText, Home, Plus, Receipt, Settings, Share2, UsersRound, Wallet, Ellipsis, ArrowUpRight, ArrowDownLeft, Repeat } from "lucide-react";
import { cn } from "@/lib/cn";
import { Sheet } from "@/components/ui/sheet";

const PRIMARY = [
  { href: "/dashboard", label: "Home", icon: Home },
  { href: "/ledgers", label: "Ledgers", icon: BookOpen },
  { href: "/contractors", label: "Client Accounts", icon: UsersRound },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/expenses", label: "Expenses", icon: Receipt },
  { href: "/advances", label: "Advances", icon: Wallet },
  { href: "/books", label: "Books", icon: BookOpenCheck },
  { href: "/reports", label: "Reports", icon: ChartColumn },
  { href: "/settings", label: "Settings", icon: Settings },
];

const QUICK_ADD = [
  { href: "/entries/new?tab=paid", label: "Paid", hint: "Your expense, a split, or money to someone", icon: ArrowUpRight },
  { href: "/entries/new?tab=received", label: "Received", hint: "From someone who owes you, borrowed, or income", icon: ArrowDownLeft },
  { href: "/entries/new?tab=book", label: "Book entry", hint: "A bill, or someone paid for you. No money moves", icon: Receipt },
  { href: "/entries/new?tab=transfer", label: "Transfer", hint: "Between cash and bank", icon: Repeat },
  { href: "/invoices/new", label: "Invoice", hint: "Bill a client and share it on WhatsApp", icon: FileText },
  { href: "/ledgers?add=entry", label: "Ledger entry", hint: "Straight into one ledger", icon: ArrowLeftRight },
  { href: "/advances/new", label: "Advance", hint: "Money given ahead of work", icon: Wallet },
  { href: "/ledgers/new?type=personal", label: "Shared account", hint: "For a group: a trip, flatmates", icon: UsersRound },
];

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

export function Sidebar({ hasWorkspace, showShared, sharedCount }: { hasWorkspace: boolean; showShared: boolean; sharedCount: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {hasWorkspace &&
        PRIMARY.map(({ href, label, icon: Icon }) => (
          <IntentLink
            key={href}
            href={href}
            aria-current={isActive(pathname, href) ? "page" : undefined}
            className={cn(
              "flex h-11 items-center gap-3 rounded-full px-4 text-[15px] font-medium transition-colors",
              isActive(pathname, href) ? "bg-ink text-surface" : "text-ink-2 hover:bg-sunken hover:text-ink",
            )}
          >
            <Icon className="size-[18px]" strokeWidth={2} />
            {label}
          </IntentLink>
        ))}
      {/* Listed in your own workspace (even before anything is shared), not in a business you joined. */}
      {showShared && (
      <IntentLink
        href="/shared"
        aria-current={isActive(pathname, "/shared") ? "page" : undefined}
        className={cn(
          "flex h-11 items-center gap-3 rounded-full px-4 text-[15px] font-medium transition-colors",
          isActive(pathname, "/shared") ? "bg-ink text-surface" : "text-ink-2 hover:bg-sunken hover:text-ink",
        )}
      >
        <Share2 className="size-[18px]" />
        Shared with me
        {sharedCount > 0 && <span className="ml-auto text-xs opacity-70">{sharedCount}</span>}
      </IntentLink>
      )}
    </nav>
  );
}

export function QuickAddButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("inline-flex h-12 items-center justify-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-surface", className)}
      >
        <Plus className="size-5" /> New
      </button>
      <QuickAddSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function QuickAddSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Add something">
      <ul className="grid gap-2 pb-2">
        {QUICK_ADD.map(({ href, label, hint, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              onClick={onClose}
              className="flex items-center gap-4 rounded-3xl bg-white p-4 ring-1 ring-inset ring-line transition-colors hover:bg-canvas"
            >
              <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-sunken">
                <Icon className="size-5" />
              </span>
              <span>
                <span className="block text-[16px] font-semibold">{label}</span>
                <span className="block text-sm text-ink-2">{hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/** Floating pill navigation for phones. Five slots: four places and the add button. */
export function BottomNav({ hasWorkspace, showShared }: { hasWorkspace: boolean; showShared: boolean }) {
  const pathname = usePathname();
  const [addOpen, setAddOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  if (!hasWorkspace) return null;
  const tab = (href: string, label: string, Icon: typeof Home) => (
    <IntentLink
      href={href}
      aria-current={isActive(pathname, href) ? "page" : undefined}
      className={cn(
        "flex size-[52px] flex-col items-center justify-center rounded-full transition-colors",
        isActive(pathname, href) ? "bg-surface text-ink" : "text-seashell/75",
      )}
    >
      <Icon className="size-5" />
      <span className="sr-only">{label}</span>
    </IntentLink>
  );
  const moreActive = ["/invoices", "/expenses", "/advances", "/reports", "/settings", "/shared"].some((h) => isActive(pathname, h));
  return (
    <>
      <nav
        aria-label="Main"
        className="no-print fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
      >
        <div className="flex items-center gap-1 rounded-full bg-ink p-1.5 shadow-[0_12px_32px_rgb(29_29_27/0.28)]">
          {tab("/dashboard", "Home", Home)}
          {tab("/ledgers", "Ledgers", BookOpen)}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            aria-label="Add something"
            className="mx-1 flex size-[52px] items-center justify-center rounded-full bg-mustard text-ink"
          >
            <Plus className="size-6" strokeWidth={2.4} />
          </button>
          {tab("/contractors", "Client Accounts", UsersRound)}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="More"
            className={cn("flex size-[52px] items-center justify-center rounded-full", moreActive ? "bg-surface text-ink" : "text-seashell/75")}
          >
            <Ellipsis className="size-5" />
          </button>
        </div>
      </nav>
      <QuickAddSheet open={addOpen} onClose={() => setAddOpen(false)} />
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <ul className="grid grid-cols-2 gap-2 pb-2">
          {[...PRIMARY.slice(3), ...(showShared ? [{ href: "/shared", label: "Shared with me", icon: Share2 }] : [])].map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <IntentLink
                href={href}
                onClick={() => setMoreOpen(false)}
                className="flex h-24 flex-col justify-between rounded-3xl bg-white p-4 ring-1 ring-inset ring-line"
              >
                <Icon className="size-5" />
                <span className="text-[15px] font-semibold">{label}</span>
              </IntentLink>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}
