"use client";
import type { ComponentProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Kind = NonNullable<Parameters<ReturnType<typeof useRouter>["prefetch"]>[1]>["kind"];

/**
 * A Link that starts rendering the whole destination on hover or first touch, so by the time the
 * tap or click completes the page is usually already on its way. Viewport prefetch stays light
 * (skeleton only), so lists never fire off dozens of page renders.
 */
export function IntentLink({ href, onMouseEnter, onTouchStart, ...rest }: ComponentProps<typeof Link> & { href: string }) {
  const router = useRouter();
  const warm = () => router.prefetch(href, { kind: "full" as Kind });
  return (
    <Link
      href={href}
      onMouseEnter={(e) => {
        onMouseEnter?.(e);
        warm();
      }}
      onTouchStart={(e) => {
        onTouchStart?.(e);
        warm();
      }}
      {...rest}
    />
  );
}
