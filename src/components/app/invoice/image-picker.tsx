"use client";
/* eslint-disable @next/next/no-img-element -- uploaded brand images */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { clearBrandImage, uploadBrandImage } from "@/app/(app)/actions/invoices";
import { brandUrl } from "@/lib/invoices/doc";

/** Shrinks an image in the browser and keeps it PNG, which a PDF can embed. */
async function shrink(file: File, max: number): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return new File([blob!], "image.png", { type: "image/png" });
}

/**
 * Upload one image. Settings images (logo, signature, stamp) save straight away; "qr" and "client"
 * only store the file and hand back its path for the form they belong to.
 */
export function ImagePicker({
  label,
  field,
  path,
  disabled,
  onPath,
}: {
  label: string;
  field: "logo_path" | "signature_path" | "stamp_path" | "qr" | "client";
  path: string | null | undefined;
  disabled?: boolean;
  onPath?: (path: string | null) => void;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState(path ?? null);
  const formOwned = field === "qr" || field === "client";
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-inset ring-line">
        {current ? <img src={brandUrl(current) ?? ""} alt="" className="size-full object-contain" /> : <span className="text-[12px] text-ink-3">None</span>}
      </div>
      <div className="flex flex-col items-start gap-1">
        <span className="text-[15px] font-semibold">{label}</span>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="secondary" disabled={disabled || pending} onClick={() => input.current?.click()}>
            {pending ? "Uploading…" : current ? "Change" : "Upload"}
          </Button>
          {current && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || pending}
              onClick={() =>
                start(async () => {
                  if (!formOwned) {
                    const res = await clearBrandImage(field as "logo_path");
                    if (!res.ok) return void toast.error(res.error);
                  }
                  setCurrent(null);
                  onPath?.(null);
                  router.refresh();
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          start(async () => {
            try {
              const form = new FormData();
              form.set("field", field);
              form.set("file", await shrink(file, 900));
              const res = await uploadBrandImage(form);
              if (!res.ok) return void toast.error(res.error);
              setCurrent(res.data!.path);
              onPath?.(res.data!.path);
              router.refresh();
            } catch {
              toast.error("That image could not be read. Try a PNG or JPG.");
            }
          });
        }}
      />
    </div>
  );
}
