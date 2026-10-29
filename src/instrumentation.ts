/**
 * Runs once when the server starts.
 *
 * Node tries each address of a host (IPv6 and IPv4, "Happy Eyeballs") for only 250 ms before
 * moving on. On slow or NAT64/IPv6-only networks a connection to Supabase or Clerk can take
 * longer than that, so every attempt is cut off and requests fail or stall. A longer window
 * changes nothing on fast networks and keeps slow ones working.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const net = await import("node:net");
    net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
  }
}
