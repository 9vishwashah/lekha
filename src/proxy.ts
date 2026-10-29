import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Session plumbing only. Authorisation is resource-based: every page, Server Function and route
 * handler checks the signed-in user itself (requireUser / auth()), and the database enforces
 * tenant and ledger access with RLS. Nothing relies on URL path matching to stay private.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
