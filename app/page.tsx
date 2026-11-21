import CommandBox from "@/components/CommandBox";
import DisplaySettings from "@/components/DisplaySettings";
import Twin from "@/components/Twin";

export default function Home() {
  return (
    <>
      <header>
        <p className="brand">
          {/* A plain link on purpose: a full load of "/" is what clears the open page and returns to the start. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" aria-label="Arc, back to the start page">
            Arc
          </a>
        </p>
        <p>
          Learn the page one <em>sweep</em> at a time.
        </p>
        <CommandBox />
        <DisplaySettings />
      </header>
      <main id="main">
        <Twin />
      </main>
    </>
  );
}
