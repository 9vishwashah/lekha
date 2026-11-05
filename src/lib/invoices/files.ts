/**
 * What a file really is, from its bytes, not its name. An uploaded invoice is stored unchanged, so
 * this is the check that stands between a renamed executable and a client's download folder.
 */
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Vercel's request limit is 4.5 MB

export function sniffMime(bytes: Uint8Array): string | null {
  const at = (i: number, ...sig: number[]) => sig.every((v, k) => bytes[i + k] === v);
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf"; // %PDF-
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) {
    // A ZIP. A Word document names its parts in plain text inside the archive.
    const text = new TextDecoder("latin1").decode(bytes);
    if (text.includes("[Content_Types].xml") && text.includes("word/")) return DOCX;
  }
  return null;
}

const EXT: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", [DOCX]: "docx" };

/** Rejects files whose content does not match an allowed type, or whose name claims a different one. */
export function checkUpload(name: string, bytes: Uint8Array): { ok: true; mime: string; ext: string } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "That file is empty" };
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, error: "Keep the file under 4 MB" };
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, error: "Upload a PDF, Word (.docx), PNG or JPG file" };
  const claimed = name.toLowerCase().split(".").pop() ?? "";
  const ext = EXT[mime];
  const same = claimed === ext || (ext === "jpg" && claimed === "jpeg");
  if (!same) return { ok: false, error: `This file is really a .${ext}, but its name says .${claimed}. Rename it and try again.` };
  return { ok: true, mime, ext };
}

/** A filename safe for a Content-Disposition header, keeping the user's name where possible. */
export function downloadName(name: string) {
  return name.replace(/[\r\n"\\/]/g, "_").replace(/[^\x20-\x7e]/g, "_").slice(0, 150) || "invoice";
}
