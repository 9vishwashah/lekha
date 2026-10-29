import net from "node:net";
import { clerkSetup } from "@clerk/testing/playwright";

// Slow or IPv6-only (NAT64) networks need longer connection attempts than Node's 250 ms default.
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

export default async function globalSetup() {
  if (!process.env.CLERK_SECRET_KEY || !process.env.E2E_USER_A_EMAIL) return;
  // Fetches a Clerk testing token so sign-in is not blocked by bot protection.
  // Retries: a slow or briefly throttled connection to Clerk shouldn't fail the whole suite.
  for (let attempt = 1; ; attempt++) {
    try {
      await clerkSetup();
      return;
    } catch (error) {
      const e = error as { status?: number; errors?: unknown; cause?: { code?: string } };
      console.error(`Clerk testing token attempt ${attempt} failed:`, e.status ?? "", JSON.stringify(e.errors ?? "").slice(0, 200), e.cause?.code ?? "");
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
