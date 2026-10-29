"use client";
import { useMemo, useState, useTransition } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import { saveContractor } from "@/app/(app)/actions/records";
import { Avatar } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";

export interface ClientOption {
  id: string;
  name: string;
  kind: "business" | "personal";
  phone?: string | null;
}

/**
 * Pick people from Client Accounts. A new person can be added inline (saved as a personal client),
 * so a shared account never holds a loose name that the rest of the app can't see.
 */
export function ClientPicker({
  clients,
  selected,
  onChange,
  exclude = [],
  multiple = true,
  name,
}: {
  clients: ClientOption[];
  selected: string[];
  onChange: (ids: string[], added?: ClientOption) => void;
  exclude?: string[];
  multiple?: boolean;
  name?: string; // renders hidden inputs for form posts
}) {
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [local, setLocal] = useState<ClientOption[]>([]);
  const all = useMemo(() => [...clients, ...local].filter((c) => !exclude.includes(c.id)), [clients, local, exclude]);
  const query = q.trim().toLowerCase();
  const list = all
    .filter((c) => !query || c.name.toLowerCase().includes(query) || c.phone?.includes(query))
    .sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)) || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "personal" ? -1 : 1));

  const toggle = (id: string) => {
    if (!multiple) return onChange(selected.includes(id) ? [] : [id]);
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const create = () =>
    start(async () => {
      setError(null);
      const form = new FormData();
      form.set("name", newName);
      form.set("phone", newPhone);
      form.set("kind", "personal");
      const res = await saveContractor(null, null, form);
      if (!res.ok) return setError(res.fieldErrors?.name ?? res.fieldErrors?.phone ?? res.error);
      const added: ClientOption = { id: res.data!.id, name: newName.trim(), kind: "personal", phone: newPhone || null };
      setLocal((l) => [...l, added]);
      onChange(multiple ? [...selected, added.id] : [added.id], added);
      setNewName("");
      setNewPhone("");
      setAdding(false);
      setQ("");
    });

  return (
    <div className="flex flex-col gap-3">
      {name && selected.map((id) => <input key={id} type="hidden" name={name} value={id} />)}
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <label className="sr-only" htmlFor="client-search">
          Search client accounts
        </label>
        <Input id="client-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your client accounts" className="pl-10" autoComplete="off" />
      </div>
      <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-1" aria-label="Client accounts">
        {list.map((c) => {
          const on = selected.includes(c.id);
          return (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(c.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-2xl p-2 pr-3 text-left ring-1 ring-inset transition-colors",
                  on ? "bg-ink text-surface ring-ink" : "bg-white ring-line hover:bg-canvas",
                )}
              >
                <Avatar name={c.name} className="size-9" tone={on ? "light" : "sunken"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className={cn("block text-[12px]", on ? "text-surface/70" : "text-ink-3")}>
                    {c.kind === "personal" ? "Friend or family" : "Client or contractor"}
                    {c.phone ? ` · ${c.phone}` : ""}
                  </span>
                </span>
                {on && <Check className="size-5" />}
              </button>
            </li>
          );
        })}
        {list.length === 0 && !adding && <li className="px-1 py-2 text-sm text-ink-3">{query ? `No one called "${q}" yet.` : "No client accounts yet."}</li>}
      </ul>

      {adding ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-canvas p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">New person</span>
            <button type="button" aria-label="Cancel" onClick={() => setAdding(false)} className="inline-flex size-9 items-center justify-center rounded-full hover:bg-sunken">
              <X className="size-4" />
            </button>
          </div>
          <label className="sr-only" htmlFor="new-person-name">
            Name
          </label>
          <Input id="new-person-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" maxLength={160} autoFocus />
          <label className="sr-only" htmlFor="new-person-phone">
            Phone (optional)
          </label>
          <Input id="new-person-phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone (optional)" type="tel" inputMode="tel" maxLength={20} />
          {error && <p className="text-[13px] font-medium text-out">{error}</p>}
          <Button size="sm" disabled={pending || !newName.trim()} onClick={create}>
            {pending ? "Adding…" : "Add to client accounts"}
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="w-fit"
          onClick={() => {
            setAdding(true);
            setNewName(q);
          }}
        >
          <Plus className="size-4" /> New person
        </Button>
      )}
    </div>
  );
}
