"use client";
import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShareSheet } from "@/components/app/share-sheet";

/** Share this person's account (expenses and payments with them) straight from their page. */
export function ShareClientAccount({ ledgerId, name }: { ledgerId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Share2 className="size-4" /> Share
      </Button>
      <ShareSheet open={open} onClose={() => setOpen(false)} ledgerId={ledgerId} ledgerName={name} taxation={false} />
    </>
  );
}
