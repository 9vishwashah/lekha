import "server-only";

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

interface PgError {
  code?: string;
  message?: string;
}

// Codes raised deliberately by our database functions carry messages written for people.
const USER_FACING = new Set(["22023", "42501", "P0002", "22001"]);

/** Turns a database error into a safe message. Internal details never reach the browser. */
export function friendly(error: PgError | null | undefined): string {
  if (!error) return "Something went wrong. Try again.";
  if (error.code && USER_FACING.has(error.code) && error.message) return error.message;
  if (error.code === "23505") {
    return error.message?.includes("already been imported")
      ? error.message
      : "This looks like a duplicate of something already saved.";
  }
  if (error.code === "23503") return "Something this refers to no longer exists. Refresh and try again.";
  if (error.code === "23514") return "Some values are outside what is allowed. Check the amounts and try again.";
  if (error.code === "PGRST303" || /jwt expired/i.test(error.message ?? "")) return "Your sign-in refreshed while saving. Nothing was saved; try again.";
  if (error.code === "PGRST301" || error.code === "PGRST302") return "Your session has expired. Sign in again.";
  console.error("[db]", error.code, error.message);
  return "Something went wrong on our side. Your entry was not saved. Try again.";
}

export function fail(error: PgError | string): ActionResult<never> {
  return { ok: false, error: typeof error === "string" ? error : friendly(error) };
}
