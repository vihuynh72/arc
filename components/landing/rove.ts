import type { KeyboardEvent } from "react";

/** One Tab stop for a whole row of choices: the arrow keys move focus along a toolbar's buttons, Home and End jump to its ends. */
export function rove(e: KeyboardEvent<HTMLElement>) {
  const all = [...e.currentTarget.querySelectorAll("button")];
  const at = all.indexOf(document.activeElement as HTMLButtonElement);
  const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 }[e.key];
  if (to === undefined || at < 0) return;
  e.preventDefault();
  all[(to + all.length) % all.length].focus();
}
