import CommandBox from "@/components/CommandBox";
import Twin from "@/components/Twin";

export default function Home() {
  return (
    <>
      <header>
        <p className="brand">Arc</p>
        <p>Learn the page one sweep at a time.</p>
        <CommandBox />
        {/* AskButton goes here: components/AskButton.tsx (hold-to-ask control), import it once the file exists. */}
      </header>
      <main id="main">
        <Twin />
      </main>
    </>
  );
}
