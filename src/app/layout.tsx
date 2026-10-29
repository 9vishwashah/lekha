import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Toaster } from "sonner";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
});

export const metadata: Metadata = {
  title: { default: "Lekha", template: "%s · Lekha" },
  description: "Contractor ledgers, taxes, advances and shared accounts that stay in sync with the people you work with.",
  applicationName: "Lekha",
};

export const viewport: Viewport = {
  themeColor: "#f2eee7",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${geist.variable} ${geistMono.variable} ${bricolage.variable} antialiased`}>
      <body className="min-h-dvh">
        <ClerkProvider
          appearance={{
            variables: {
              colorPrimary: "#1d1d1b",
              colorBackground: "#fbfaf7",
              borderRadius: "14px",
              fontFamily: "var(--font-geist)",
            },
          }}
        >
          {children}
          <Toaster
            position="top-center"
            toastOptions={{
              style: { background: "#1d1d1b", color: "#fbfaf7", border: "none", borderRadius: 18, fontFamily: "var(--font-geist)" },
            }}
          />
        </ClerkProvider>
      </body>
    </html>
  );
}
