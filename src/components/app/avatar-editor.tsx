"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera } from "lucide-react";
import { Avatar } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { removeAvatar, uploadAvatar } from "@/app/(app)/actions/workspace";

const SIZE = 320;

/** Centre-crops any photo to a square and shrinks it, so uploads are small (about 20–40 KB). */
async function squareWebp(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (blob && blob.type === "image/webp") return blob;
  // Safari without WebP encoding: JPEG instead.
  return (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88)))!;
}

/** Your profile photo: shown on your account, in shared accounts and wherever people see you. */
export function AvatarEditor({ name, photo }: { name: string; photo: string | null }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(photo);
  const [pending, start] = useTransition();

  const choose = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return void toast.error("Choose a photo");
    start(async () => {
      try {
        const blob = await squareWebp(file);
        const form = new FormData();
        form.set("photo", new File([blob], `photo.${blob.type.split("/")[1]}`, { type: blob.type }));
        const res = await uploadAvatar(form);
        if (!res.ok) return void toast.error(res.error);
        setPreview(res.data!.url);
        toast.success("Photo updated");
        router.refresh();
      } catch {
        toast.error("That photo could not be read. Try another.");
      }
    });
  };

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={pending}
        className="group relative rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        aria-label="Change profile photo"
      >
        <Avatar name={name || "?"} src={preview} tone="ink" className="size-20 text-2xl" />
        <span className="absolute -bottom-0.5 -right-0.5 inline-flex size-8 items-center justify-center rounded-full bg-mustard text-ink ring-4 ring-surface">
          <Camera className="size-4" />
        </span>
        {pending && <span className="absolute inset-0 animate-pulse rounded-full bg-white/50" />}
      </button>
      <div className="flex flex-col items-start gap-1.5">
        <span className="text-[15px] font-semibold">Profile photo</span>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => input.current?.click()}>
            {pending ? "Uploading…" : preview ? "Change" : "Add photo"}
          </Button>
          {preview && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await removeAvatar();
                  if (!res.ok) return void toast.error(res.error);
                  setPreview(null);
                  router.refresh();
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <input ref={input} type="file" accept="image/*" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} tabIndex={-1} />
    </div>
  );
}
