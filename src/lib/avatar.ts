/** Public URL of a profile photo stored in the "avatars" bucket, or null when there is none. */
export function avatarUrl(path: string | null | undefined): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!path || !base) return null;
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/avatars/${path.split("/").map(encodeURIComponent).join("/")}`;
}
