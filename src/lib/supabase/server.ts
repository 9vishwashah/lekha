import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "@/lib/env";

const noStore: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

/** Seconds until a JWT expires (negative when already expired). */
function secondsLeft(jwt: string) {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()) as { exp?: number };
    return (exp ?? 0) - Date.now() / 1000;
  } catch {
    return -1;
  }
}

/**
 * Supabase client acting as the signed-in Clerk user (official third-party auth integration).
 * Every query runs under that user's identity, so Row Level Security applies on the server too.
 *
 * Clerk session tokens are short-lived (about a minute). A page can make several requests, and on
 * a slow connection the token in the request may expire part-way through. When fewer than 20
 * seconds remain, a fresh token for the same session is fetched once and reused.
 */
export async function userDb() {
  const { url, key } = supabaseEnv();
  const { getToken, sessionId } = await auth();
  let fresh: string | null = null;
  const token = async () => {
    if (fresh && secondsLeft(fresh) > 20) return fresh;
    const current = await getToken();
    if (!current || !sessionId || secondsLeft(current) > 20) return current ?? null;
    try {
      const minted = await (await clerkClient()).sessions.getToken(sessionId);
      fresh = minted.jwt;
      return fresh;
    } catch {
      return current; // still valid for a few seconds, or Supabase will say it expired
    }
  };
  return createClient(url, key, {
    accessToken: token,
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: noStore },
  });
}

/** Anonymous client: can only call the narrowly scoped public functions (shared ledgers, invite previews). */
export function anonDb() {
  const { url, key } = supabaseEnv();
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: noStore },
  });
}

export type Db = Awaited<ReturnType<typeof userDb>>;
