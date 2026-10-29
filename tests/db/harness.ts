import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Boots an in-process Postgres with the same auth surface Supabase exposes:
 * roles anon / authenticated, and auth.jwt() reading request.jwt.claims.
 * Every migration in supabase/migrations is applied in order.
 */
const SUPABASE_SHIM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), '')::jsonb,
    nullif(current_setting('request.jwt.claims', true), '')::jsonb)
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;
grant usage on schema public to anon, authenticated;
`;

const MIGRATIONS = path.resolve(process.cwd(), "supabase/migrations");
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

async function apply(db: PGlite, files: string[]) {
  for (const file of files) {
    try {
      await db.exec(readFileSync(path.join(MIGRATIONS, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
}

/** Fresh database with every migration applied, or only those before `until` (for upgrade tests). */
export async function createDb(options: { until?: string } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  await apply(db, migrationFiles().filter((f) => !options.until || f < options.until));
  return db;
}

/** Applies the remaining migrations from `from` onwards, as an upgrade of an existing database. */
export async function applyFrom(db: PGlite, from: string) {
  await apply(db, migrationFiles().filter((f) => f >= from));
}

export type Db = Awaited<ReturnType<typeof createDb>>;

/** Runs fn as a signed-in Clerk user (or anon when userId is null), inside a transaction. */
export async function as<T>(db: Db, userId: string | null, fn: (q: Query) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : "";
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await tx.exec(`set local role ${userId ? "authenticated" : "anon"}`);
    const q: Query = async (sql, params) => (await tx.query(sql, params)).rows as never;
    return fn(q);
  });
}

export type Query = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** Calls an RPC that returns a single value. */
export async function rpc<T = unknown>(db: Db, userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  return as(db, userId, async (q) => {
    const rows = await q<{ r: T }>(`select ${sql} as r`, params);
    return rows[0]?.r as T;
  });
}
