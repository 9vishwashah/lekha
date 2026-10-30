import { z } from "zod";

export const fullName = z.string().trim().min(2, "Enter your name").max(120, "Keep your name under 120 characters");
// Indian 10-digit mobile (6–9 first) or an international number with +country code.
export const mobile = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s()-]/g, ""))
  .pipe(
    z
      .string()
      .regex(/^(?:\+91)?[6-9]\d{9}$|^\+(?!91)\d{10,15}$/, "Enter a 10-digit mobile number, or +country code and number")
      .transform((s) => (s.startsWith("+") ? s : `+91${s}`)),
  );

/** @username: 3–20 lowercase letters, numbers, dots or underscores; a leading @ is ignored. */
export const username = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_.]{2,19}$/, "Use 3–20 letters, numbers, dots or underscores"));
