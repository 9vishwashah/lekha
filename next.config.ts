import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Financial pages are always rendered per request for the signed-in user; nothing private is cached.
  serverExternalPackages: ["exceljs", "pdf-lib", "@pdf-lib/fontkit"],
  experimental: {
    // Keep visited screens in the client cache so switching back to a tab is instant. Links prefetch
    // only the loading skeleton (the default), so a tap responds at once without the server
    // rendering every destination in the background.
    // Every save calls revalidatePath/router.refresh, which clears this cache, so data never goes stale after a change.
    staleTimes: { dynamic: 60, static: 300 },
  },
  outputFileTracingIncludes: {
    "/api/export/**": ["./assets/fonts/**"],
    "/api/share/**": ["./assets/fonts/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Share links live in the path; never leak them through the Referer header.
      { source: "/s/:token*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex" }] },
      { source: "/invite/:token*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex" }] },
    ];
  },
};

export default nextConfig;
