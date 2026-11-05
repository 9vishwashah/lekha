"use client";
import { type ReactNode, useEffect, useRef, useState } from "react";

const SHEET = 794;

/** Scales a fixed-width A4 sheet to its container, so a phone shows the whole page, not a crop. */
export function ScaledSheet({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, height: 0 });

  useEffect(() => {
    const measure = () => {
      if (!outer.current || !inner.current) return;
      const scale = Math.min(1, outer.current.clientWidth / SHEET);
      setView({ scale, height: inner.current.offsetHeight * scale });
    };
    const ro = new ResizeObserver(measure);
    if (outer.current) ro.observe(outer.current);
    if (inner.current) ro.observe(inner.current);
    measure();
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={outer} className={className} style={{ height: view.height || undefined, overflow: "hidden" }}>
      <div ref={inner} style={{ width: SHEET, transform: `scale(${view.scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}
