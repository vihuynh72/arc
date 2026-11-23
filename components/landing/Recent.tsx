"use client";
// "Pick up where you left off": the public pages opened lately, kept in this browser only (lib/client/recent.ts), for low vision and
// a sighted helper; by voice it is "continue". Nothing on the server or first client render, so nothing differs at hydration.
import { useMemo, useSyncExternalStore } from "react";
import { addressFor } from "@/lib/client/place";
import { speaker } from "@/lib/client/reader";
import { clearRecent, parseRecent, recentRaw, saidTitle } from "@/lib/client/recent";

const KIND = { page: "Page", pdf: "PDF", video: "Video" };
const subscribe = (f: () => void) => {
  window.addEventListener("storage", f);
  window.addEventListener("arc:recent", f);
  return () => (window.removeEventListener("storage", f), window.removeEventListener("arc:recent", f));
};

export default function Recent() {
  const raw = useSyncExternalStore(subscribe, recentRaw, () => "");
  const list = useMemo(() => parseRecent(raw).slice(0, 5), [raw]);
  if (!list.length) return null;
  return (
    <section className="lp-recent" aria-labelledby="recent-title">
      <h2 id="recent-title">Pick up where you left off</h2>
      <ul>
        {list.map((e) => (
          <li key={e.url}>
            <a
              href={addressFor(e.url)}
              onClick={(ev) => {
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return; // a new tab or window opens the link as usual
                ev.preventDefault();
                // The command first, then the words: opening a page stops what is being said (the same order as a spoken "continue").
                window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "open", args: { url: e.url, ...(e.place && { place: e.place }) } } }));
                void speaker.say([`Opening ${saidTitle(e.title)}${e.place ? ", where you left off" : ""}.`]);
              }}
            >
              {e.title}
            </a>
            <span>{KIND[e.kind]}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          clearRecent();
          void speaker.say(["Forgotten. Nothing from before is kept on this browser."]);
          document.getElementById("command")?.focus();
        }}
      >
        Forget this list
      </button>
    </section>
  );
}
