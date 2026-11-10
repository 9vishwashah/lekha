import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "@/lib/env";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([502, 503, 504, 520, 522, 524]);

/**
 * fetch for Supabase from the server: never cached, and a brief network blip doesn't take a page
 * down. Reads (GET/HEAD) are retried up to twice on a dropped connection or a gateway error. Writes
 * are never retried here, so nothing can be saved twice. A request refused only because the
 * sign-in token expired is retried once with a fresh token (it was never run, so this is safe).
 */
export function resilientFetch(refreshToken?: () => Promise<string | null>): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const read = method === "GET" || method === "HEAD";
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(input, { ...init, cache: "no-store" });
        if (read && attempt < 2 && RETRY_STATUS.has(res.status)) {
          await sleep(150 * (attempt + 1));
          continue;
        }
        if (res.status === 401 && refreshToken && !reauthed) {
          const body = await res.clone().text();
          if (/JWT expired|PGRST301|PGRST303/i.test(body)) {
            const jwt = await refreshToken();
            if (jwt) {
              reauthed = true;
              const headers = new Headers(init?.headers);
              headers.set("Authorization", `Bearer ${jwt}`);
              init = { ...init, headers };
              continue;
            }
          }
        }
        return res;
      } catch (err) {
        if (!read || attempt >= 2 || (init?.signal as AbortSignal | undefined)?.aborted) throw err;
        await sleep(150 * (attempt + 1));
      }
    }
  };
}

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
 * seconds remain, a fresh token for the same session is fetched once and reused; if Supabase still
 * says it expired, the request is retried once with a newly minted token.
 */
export async function userDb() {
  const { url, key } = supabaseEnv();
  const { getToken, sessionId } = await auth();
  let fresh: string | null = null;
  const mint = async () => {
    if (!sessionId) return null;
    try {
      fresh = (await (await clerkClient()).sessions.getToken(sessionId)).jwt;
      return fresh;
    } catch {
      return null;
    }
  };
  const token = async () => {
    if (fresh && secondsLeft(fresh) > 20) return fresh;
    const current = await getToken();
    if (!current || !sessionId || secondsLeft(current) > 20) return current ?? null;
    return (await mint()) ?? current; // still valid for a few seconds, or the retry mints again
  };
  return createClient(url, key, {
    accessToken: token,
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: resilientFetch(mint) },
  });
}

/** Anonymous client: can only call the narrowly scoped public functions (shared ledgers, invite previews). */
export function anonDb() {
  const { url, key } = supabaseEnv();
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: resilientFetch() },
  });
}

export type Db = Awaited<ReturnType<typeof userDb>>;
