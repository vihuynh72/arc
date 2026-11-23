import HelperInstall from "@/components/landing/HelperInstall";
import Recent from "@/components/landing/Recent";
import Seen from "@/components/landing/Seen";
import Show from "@/components/landing/Show";
import Spectrum from "@/components/landing/Spectrum";
import { ARC, TODAY } from "@/components/landing/scenes";
import { GREETING, HELPER_STORE_URL } from "@/lib/keys";

// What Arc shows when nothing is loaded; rendered by the empty branch in components/Twin.tsx. The one box stays in the header
// above, so the first form control is still the ask box. Four movements: what Arc is, what blind students get today (quoted from
// the demo paper, lecture and PDF as published), the same material in Arc, and what does the work. The moving parts are
// components/landing/*; they are silent and hidden from Arc's own speech. Styles: app/landing.css.

const KEYS: [string[], string][] = [
  [["↓", "↑"], "Next and previous paragraph."],
  [["H"], "Next heading."],
  [["F"], "Next figure."],
  [["Enter"], "On a figure: start its tour. It plays by itself; the arrow keys take over."],
  [["Space"], "Hold it and say what you want, or ask a question."],
  [["/"], "Type instead."],
  [["Cmd", "→"], "Read faster; with the left arrow, slower. Ctrl on Windows."],
  [["Esc"], "Go back."],
];

const STEPS = [
  ["Fetch", "A plain request first. When a page blocks it, Bright Data’s Web Unlocker gets the page.", "mdpi.com/1424-8220/24/6/1935"],
  ["Parse", "Plain code finds the headings, paragraphs and figures. Ids, counts and order never come from a model.", "23 sections, 22 figures"],
  ["Ask the model", "Gemini is asked only for what code cannot know: what a figure shows, a chart’s values, what a lecture has on screen.", "Figure 1: 6 stops"],
  ["Speak", "Kokoro reads the page aloud. Gemini Live hears a spoken question and answers it.", "“1 Introduction”"],
];

const STACK = [
  ["Gemini", "A decision model turns a request into a command and acts only when it is sure. Gemini Live carries spoken questions and answers. Gemini vision writes figure tours, reads chart values and describes what a lecture shows."],
  ["Bright Data", "Reaches live pages: Web Unlocker for pages that block plain requests, the Browser API for pages that only work in a real browser, and search."],
  ["Kokoro", "The open-source reading voice. It runs on the same machine as Arc, so reading costs nothing and no page text leaves Arc to be spoken."],
  ["Open scholarly indexes", "OpenAlex, Crossref, Semantic Scholar and PubMed find a paper’s legal free copy when its link is behind a paywall."],
  ["Next.js and TypeScript", "One Node process serves the app and the voice socket. Parsing and spatial directions are plain code."],
];

export default function Landing() {
  return (
    <div className="landing">
      <Recent />

      <section className="lp-hero" aria-labelledby="landing-title">
        <h1 id="landing-title">
          {"Study any paper, chart or lecture by ear.".split(" ").map((w, i) => (
            <span key={i} style={{ "--d": `${700 + i * 330}ms` } as React.CSSProperties}>
              {w}{" "}
            </span>
          ))}
        </h1>
        <div>
          <p>Arc is a study tool for blind and low-vision students. It reads web pages, PDFs and lecture videos aloud, and takes you through their figures, charts and formulas by key and by voice.</p>
          {/* The words Arc says when this page opens (components/AskButton.tsx), for anyone who sees them first. */}
          <p className="lp-greet">
            When this page opens, Arc says: <q>{GREETING.replace(/^Arc\. /, "")}</q>
          </p>
        </div>
      </section>

      <section className="lp-problem" aria-labelledby="problem-title">
        <h2 id="problem-title">Blind students cannot study the way their classmates do.</h2>
        <p className="lp-lead">The tools they are given were built for text. On what teaching leans on most, the figure, the chart, the lecture video and the formula, those tools go quiet.</p>

        <h3 id="spectrum-title">Blindness is not one thing</h3>
        <p className="lp-sub">One page of a research paper, under six kinds of sight. These are impressions, not a medical simulation.</p>
        <Spectrum />

        <h3 id="today-title">What a screen reader has to work with</h3>
        <p className="lp-sub">A screen reader reads what a page gives it. This is what a published paper, a lecture and a PDF give it.</p>
        <Show scenes={TODAY} label="What a screen reader is given" voice="A screen reader" />
      </section>

      <section className="lp-arc" aria-labelledby="arc-title">
        <h2 id="arc-title">Arc says what they leave out.</h2>
        <p className="lp-lead">The same figure, chart, lecture and formula, in Arc. Then a page, a spoken request and a question.</p>
        <Show scenes={ARC} label="Arc at work" voice="Arc" bar />

        <h3 id="keys-title">The keys worth knowing</h3>
        <ul className="lp-keys">
          {KEYS.map(([keys, does]) => (
            <li key={does}>
              <span>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
              {does}
            </li>
          ))}
        </ul>
        <p className="lp-say">
          Or say it: <q>find a paper about knee rehabilitation</q>, <q>open the first one</q>, <q>tour figure one</q>, <q>bigger text</q>, <q>I am blind</q>.
        </p>

        <div className="lp-helper">
          <h3 id="helper-title">Send any page to Arc with one key</h3>
          <p className="lp-sub">
            The Arc helper is a Chrome extension. Press one key on the page you are on, and Arc opens it and reads it aloud. It reads from your own browser, so pages behind a sign-in work too. Arc never gets your password, cookies or tokens, and the helper never clicks or types for you.
          </p>
          <HelperInstall storeUrl={HELPER_STORE_URL} />
        </div>
      </section>

      <section className="lp-how" aria-labelledby="how-title">
        <h2 id="how-title">What changes for the student</h2>
        <p className="lp-lead">A figure stops being a file name: it becomes its parts, in order, and where each one sits. A chart becomes its message and its numbers. A lecture says what is on the board. A formula is spoken as math. And at any point the student can ask, in their own words.</p>

        <h3 id="pipe-title">How a link becomes something to listen to</h3>
        <Seen className="lp-pipe">
          <ol>
            {STEPS.map(([name, does, made], i) => (
              <li key={name} style={{ "--i": i } as React.CSSProperties}>
                <i aria-hidden="true" />
                <strong>{name}</strong>
                <span>{does}</span>
                <small>{made}</small>
              </li>
            ))}
          </ol>
        </Seen>

        <h3 id="stack-title">What does the work</h3>
        <dl className="lp-stack">
          {STACK.map(([name, does]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{does}</dd>
            </div>
          ))}
        </dl>
        <p className="lp-credit">
          Shown here: “Development of Wearable Devices for Collecting Digital Rehabilitation/Fitness Data from Lower Limbs”, Sensors 2024, 24(6), 1935, MDPI, CC BY 4.0: its Figure 1, and its Figure 20 redrawn from the values Arc read off it. “Reading pie graphs”, Khan Academy, CC BY-NC-SA, redrawn from one frame. “Attention Is All You Need”, Vaswani and others, 2017, page 4.
        </p>
      </section>
    </div>
  );
}
