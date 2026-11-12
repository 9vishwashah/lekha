"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BookUser, Check, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Segmented } from "@/components/ui/segmented";
import { ContractorForm } from "@/components/app/contractor-form";
import { AddByUsername } from "@/components/app/add-by-username";
import { whatsappUrl } from "@/components/app/share-sheet";
import { addClientByUsername, phonesOnLekha } from "@/app/(app)/actions/people";
import { inviteMessage } from "@/lib/invite";

type Picked = { name: string; phone: string | null; key: string | null };
type ContactsApi = { select: (props: string[], opts: { multiple: boolean }) => Promise<{ name?: string[]; tel?: string[] }[]> };

const phoneKey = (p: string | null) => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

export function AddContractorButton({
  existing,
  me,
}: {
  existing: { id: string; name: string; phone: string | null }[];
  me: { name: string | null; username: string | null };
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"details" | "username">("details");
  const [kind, setKind] = useState<"business" | "personal">("personal");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [onLekha, setOnLekha] = useState<Set<string>>(new Set());
  const [prefill, setPrefill] = useState<{ name: string; phone: string; n: number } | null>(null);
  const [supported, setSupported] = useState(false);
  const [checking, startCheck] = useTransition();
  const router = useRouter();
  const known = new Set(existing.map((e) => phoneKey(e.phone)).filter(Boolean));

  useEffect(() => {
    // The Contact Picker exists in Chrome on Android; elsewhere people type the name and number.
    const t = setTimeout(() => setSupported("contacts" in navigator && "ContactsManager" in window), 0);
    return () => clearTimeout(t);
  }, []);

  const pick = async () => {
    try {
      const api = (navigator as unknown as { contacts: ContactsApi }).contacts;
      const list = await api.select(["name", "tel"], { multiple: true });
      const rows: Picked[] = list
        .map((c) => {
          const phone = c.tel?.[0]?.replace(/[^\d+]/g, "") ?? null;
          return { name: (c.name?.[0] ?? "").trim() || phone || "Unnamed", phone, key: phoneKey(phone) };
        })
        .slice(0, 100);
      setPicked(rows);
      if (rows.length === 1) setPrefill({ name: rows[0].name, phone: rows[0].phone ?? "", n: Date.now() });
      startCheck(async () => {
        const keys = await phonesOnLekha(rows.map((r) => r.phone).filter((p): p is string => Boolean(p)));
        setOnLekha(new Set(keys));
      });
    } catch {
      // Closed the picker without choosing.
    }
  };

  const invite = (p: Picked) =>
    window.open(whatsappUrl(inviteMessage(p.name, me, window.location.origin), p.phone ? p.phone.replace(/\D/g, "").replace(/^(\d{10})$/, "91$1") : null), "_blank", "noopener,noreferrer");

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-5" /> Add client
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="New client account">
        <div className="flex flex-col gap-4 pb-2">
          <Segmented
            label="Add by"
            value={mode}
            onChange={setMode}
            options={[
              { value: "details", label: "Name & phone" },
              { value: "username", label: "@username" },
            ]}
          />

          {mode === "username" ? (
            <>
              <Segmented
                label="Type of account"
                value={kind}
                onChange={setKind}
                options={[
                  { value: "personal", label: "Friend or family" },
                  { value: "business", label: "Client or contractor" },
                ]}
              />
              <AddByUsername
                label="Their Lekha username"
                actionLabel="Add client"
                onAdd={async (username) => {
                  const res = await addClientByUsername(username, kind);
                  if (!res.ok) {
                    toast.error(res.error);
                    return false;
                  }
                  toast.success(res.message ?? "Added");
                  setOpen(false);
                  router.push(`/contractors/${res.data!.id}`);
                  return true;
                }}
              />
              <p className="text-[13px] text-ink-3">Linked from the start: what you add with them shows in their Lekha, and what they add shows here.</p>
            </>
          ) : (
            <>
              {supported ? (
                <Button variant="secondary" onClick={pick}>
                  <BookUser className="size-4" /> Pick from contacts
                </Button>
              ) : (
                <p className="rounded-2xl bg-sunken p-3 text-[13px] text-ink-2">
                  Picking from your phone’s contacts works in Chrome on Android. Here, type the name and number below.
                </p>
              )}

              {picked.length > 0 && (
                <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
                  {picked.map((p, i) => {
                    const added = p.key && known.has(p.key);
                    const on = p.key && onLekha.has(p.key);
                    return (
                      <li key={`${p.key ?? p.name}-${i}`} className="flex items-center gap-3 rounded-2xl bg-surface p-3 ring-1 ring-inset ring-line">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{p.name}</div>
                          <div className="truncate text-[13px] text-ink-3">
                            {p.phone ?? "No number"}
                            {on && <span className="ml-2 font-semibold text-in">On Lekha</span>}
                            {added && <span className="ml-2">· already a client</span>}
                          </div>
                        </div>
                        {!added && (
                          <Button size="sm" variant="secondary" onClick={() => setPrefill({ name: p.name, phone: p.phone ?? "", n: Date.now() })}>
                            <Check className="size-4" /> Use
                          </Button>
                        )}
                        {!on && !checking && (
                          <Button size="sm" variant="ghost" onClick={() => invite(p)} aria-label={`Invite ${p.name} on Lekha`}>
                            <Send className="size-4" /> Invite
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <ContractorForm
                key={prefill?.n ?? 0}
                prefill={prefill ?? undefined}
                existing={existing}
                onDone={(id) => {
                  setOpen(false);
                  router.push(`/contractors/${id}`);
                }}
              />
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
