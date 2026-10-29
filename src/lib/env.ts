/**
 * Environment access. Missing configuration surfaces as a clear setup screen instead of mock data.
 */
export class ConfigError extends Error {
  constructor(public missing: string[]) {
    super(`Missing configuration: ${missing.join(", ")}`);
  }
}

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const missing = [!url && "NEXT_PUBLIC_SUPABASE_URL", !key && "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"].filter(Boolean) as string[];
  if (missing.length) throw new ConfigError(missing);
  return { url: url!, key: key! };
}

export function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
