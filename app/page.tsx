import AskButton from "@/components/AskButton";
import CommandBox from "@/components/CommandBox";
import DisplaySettings from "@/components/DisplaySettings";
import Twin from "@/components/Twin";

export default function Home() {
  return (
    <>
      <header>
        <p className="brand">Arc</p>
        <p>
          Learn the page one <em>sweep</em> at a time.
        </p>
        <CommandBox />
        <AskButton />
        <DisplaySettings />
      </header>
      <main id="main">
        <Twin />
      </main>
    </>
  );
}
