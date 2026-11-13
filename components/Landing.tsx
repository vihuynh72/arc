import LandingMotion from "@/components/landing/Motion";
import {
  ChartArt,
  FigureArt,
  TextArt,
  VideoArt,
} from "@/components/landing/Vignettes";

// What Arc shows when nothing is loaded. Static; rendered by the empty branch in components/Twin.tsx.
// The one box stays in the header above, so the first form control is still the command box.
// The example links use the deep links Twin already reads (?url=); lib/intent.ts opens the same pages by voice.
const PAPER = "/?url=https%3A%2F%2Fwww.mdpi.com%2F1424-8220%2F24%2F6%2F1935";
const VIDEO = "/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DEPvd-3712U8";
const TEXTBOOK =
  "/?url=https%3A%2F%2Fopenstax.org%2Fbooks%2Fanatomy-and-physiology-2e%2Fpages%2F17-9-the-endocrine-pancreas";

const STATIONS = [
  {
    role: "You speak",
    name: "Gemini Live",
    num: "live",
    job: "\u201cFind a paper about knee rehabilitation.\u201d Gemini transcribes while you speak.",
    more: "Gemini Live carries speech in and out over one live session, so Arc hears you as you talk.",
  },
  {
    role: "Decides",
    name: "SubQ Snap",
    num: "0.2 s",
    job: "Decides the command in about 0.2 s, and only acts when it is sure.",
    more: "A decision model. It returns a probability for every option, so Arc can refuse to guess.",
  },
  {
    role: "Finds the page",
    name: "Bright Data",
    num: "< 2 s",
    job: "Searches the web, first results in under 2 s, and fetches pages that block plain requests: a blocked paper in about 11 s, a preview readable in under 1 s. Follows the real page live.",
    more: "Search, page fetch, and a live remote browser. Used wherever a site blocks plain requests.",
  },
  {
    role: "Sees and answers",
    name: "Gemini",
    num: "1 s",
    job: "Looks at figures and charts, outlines videos (4.5 minutes in about 6 s), and speaks tours and answers, which begin in about 1 s.",
    more: "Gemini Live for speech in and out, vision for figures and charts, long video understanding.",
  },
  {
    role: "Reads aloud",
    name: "Kokoro",
    num: "free",
    job: "A free local voice reads the page.",
    more: "Runs on the laptop, costs nothing per sentence.",
  },
];

export default function Landing() {
  return (
    <div className="landing">
      <LandingMotion />
      <section className="landing-hero" aria-labelledby="landing-title">
        <h1 id="landing-title">
          Study any paper, chart or video <em>by ear</em>.
        </h1>
        <p className="landing-lede">
          Arc is a study tool for blind and low-vision students. Give it a link
          or ask for a paper; it rebuilds the page as a calm copy that reads
          aloud, with a ring that moves from part to part as you go.
        </p>
      </section>

      <section className="landing-block lr-reads" aria-labelledby="reads-title">
        <h2 id="reads-title" data-eyebrow="Four kinds of material">
          What Arc <em>reads</em>
        </h2>
        <ul className="lr-grid">
          <li>
            <TextArt />
            <p className="lr-tech">Bright Data · Kokoro</p>
            <h3>Text</h3>
            <p>
              An article or a textbook page becomes parts you move through by
              ear: the ring goes heading by heading, paragraph by paragraph, and
              a voice reads each one.
            </p>
            <a href={TEXTBOOK}>Open a textbook chapter</a>
          </li>
          <li>
            <FigureArt />
            <p className="lr-tech">Gemini vision · Gemini Live</p>
            <h3>Figures</h3>
            <p>
              A figure becomes a guided tour. Arc tells you which way to move,
              names each part as you arrive, and plays a soft chime. On a
              figure, press Enter or say tour.
            </p>
            <a href={PAPER}>Open a research paper</a>
          </li>
          <li>
            <ChartArt />
            <p className="lr-tech">Gemini vision · code-checked numbers</p>
            <h3>Charts</h3>
            <p>
              A chart gives its message first, then its values. Sweep across it
              and a tone rises and falls with the curve. In the paper, say: go
              to figure 20.
            </p>
            <a href={PAPER}>Open the paper&rsquo;s charts</a>
          </li>
          <li>
            <VideoArt />
            <p className="lr-tech">Gemini</p>
            <h3>Video</h3>
            <p>
              A video becomes an outline of what is said and what is shown, part
              by part, so you can move through a lecture the way you move
              through a page.
            </p>
            <a href={VIDEO}>Open a video outline</a>
          </li>
        </ul>
        <p className="lr-or">
          Or say: &ldquo;open the paper&rdquo;, &ldquo;open the video&rdquo; or
          &ldquo;open the textbook&rdquo;.
        </p>
      </section>

      <section className="landing-block lr-pipe" aria-labelledby="pipe-title">
        <h2 id="pipe-title" data-eyebrow="Under the hood">
          One request, four <em>technologies</em>
        </h2>
        <div className="lr-trace">
          <span className="lr-track" aria-hidden="true" />
          <span className="lr-marker" aria-hidden="true" />
          <ol>
            {STATIONS.map((st, i) => (
              <li
                key={st.name}
                className="lr-st"
                style={{ ["--i" as string]: i }}
              >
                <label>
                  <input
                    className="lr-pick"
                    type="radio"
                    name="lr-station"
                    aria-describedby={`lr-job-${i} lr-more-${i}`}
                  />
                  <span className="lr-node" aria-hidden="true" />
                  <span className="lr-role">
                    {st.role}
                    <span className="lr-sr">: </span>
                  </span>{" "}
                  <strong>{st.name}</strong>
                </label>
                <p className="lr-num" aria-hidden="true">
                  {st.num}
                </p>
                <p className="lr-job" id={`lr-job-${i}`}>
                  {st.job}
                </p>
                <p className="lr-more" id={`lr-more-${i}`}>
                  {st.more}
                </p>
              </li>
            ))}
          </ol>
        </div>
        <p className="lr-note-line">
          Point at a step, or use the arrow keys on it, to pause there and read
          why. Times are from tests.
        </p>
      </section>

      <div className="lr-pair">
        <section className="landing-block" aria-labelledby="learn-title">
          <h2 id="learn-title" data-eyebrow="Keys">
            Three things to <em>learn</em>
          </h2>
          <div>
            <ul className="landing-keys">
              <li>
                <span className="keys">
                  <kbd>Space</kbd>
                </span>
                <span>Hold it and speak. Let go and Arc acts.</span>
              </li>
              <li>
                <span className="keys" role="img" aria-label="Arrow keys">
                  <kbd>&larr;</kbd>
                  <kbd>&uarr;</kbd>
                  <kbd>&darr;</kbd>
                  <kbd>&rarr;</kbd>
                </span>
                <span>Move through the page, one part at a time.</span>
              </li>
              <li>
                <span className="keys">
                  <kbd>Esc</kbd>
                </span>
                <span>Stop the voice at once.</span>
              </li>
            </ul>
            <p className="lr-also">Or click anything to hear it.</p>
          </div>
        </section>

        <section className="landing-block" aria-labelledby="try-title">
          <h2 id="try-title" data-eyebrow="Voice">
            Try <em>saying</em>
          </h2>
          <ul className="landing-try">
            <li>I am blind</li>
            <li>Find a paper about knee rehabilitation</li>
            <li>Open the first one</li>
            <li>Tour figure one</li>
            <li>Bigger text</li>
          </ul>
        </section>
      </div>

      <p className="landing-foot">
        Built for blind and low-vision students; not yet tested with them.{" "}
        <a href="https://github.com/vihuynh72/arc">Open source on GitHub</a>.
      </p>
    </div>
  );
}
