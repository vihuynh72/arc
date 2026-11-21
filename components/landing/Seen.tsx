"use client";
// Marks its box with data-seen the first time it scrolls into view, so a one-time entrance (app/landing.css) plays when the visitor
// gets there and never again. Used by components/Landing.tsx.
import { useEffect, useRef, useState, type ReactNode } from "react";

export default function Seen({ className, children }: { className: string; children: ReactNode }) {
  const [seen, setSeen] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setSeen(true), io.disconnect()), { threshold: 0.5 });
    io.observe(el.current!);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={el} className={className} data-seen={seen || undefined}>
      {children}
    </div>
  );
}
