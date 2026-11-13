"use client";

import { useEffect } from "react";

// Runs the landing loops only while they sit in the middle of the screen, so at most a row of them moves at once.
// Sets data-run on each .lr-art / .lr-trace; app/landing.css pauses the ones without it. Rendered by components/Landing.tsx.
export default function LandingMotion() {
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          e.target.toggleAttribute("data-run", e.isIntersecting);
      },
      { rootMargin: "-25% 0px -25% 0px" },
    );
    document
      .querySelectorAll(".lr-art, .lr-trace")
      .forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
