// What Arc shows when nothing is loaded. Static; rendered by the empty branch in components/Twin.tsx.
// The one box stays in the header above, so the first form control is still the command box.
export default function Landing() {
  return (
    <div className="landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div>
          <h1 id="landing-title">
            Study any paper, page or video <em>by ear</em>.
          </h1>
          <p className="landing-lede">
            Arc is a study tool for blind and low-vision students. Give it a link or ask for a paper, and it rebuilds the page as a calm, simple copy that reads aloud, with a ring
            that moves from part to part as you go.
          </p>
        </div>
        <div className="landing-demo" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <i />
        </div>
      </section>

      <section className="landing-block" aria-labelledby="learn-title">
        <h2 id="learn-title">Three things to <em>learn</em></h2>
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
      </section>

      <section className="landing-block" aria-labelledby="try-title">
        <h2 id="try-title">Try <em>saying</em></h2>
        <ul className="landing-try">
          <li>Find a paper about knee rehabilitation</li>
          <li>Open the first one</li>
          <li>Take me to the results</li>
          <li>Tour figure one</li>
        </ul>
      </section>

      <section className="landing-block" aria-labelledby="how-title">
        <h2 id="how-title">How it <em>works</em></h2>
        <ol className="landing-how">
          <li>
            <strong>You speak, Snap decides, the ring moves.</strong> SubQ Snap reads each request in about a fifth of a second and acts only when it is sure.
          </li>
          <li>
            <strong>Bright Data finds and follows the real page.</strong> Web search, page fetch, and a live browser that scrolls along with you.
          </li>
          <li>
            <strong>Gemini speaks and sees.</strong> Spoken answers, guided figure tours, and video outlines of what is said and shown.
          </li>
        </ol>
      </section>

      <p className="landing-foot">
        Built for blind and low-vision students; not yet tested with them. <a href="https://github.com/vihuynh72/arc">Open source on GitHub</a>.
      </p>
    </div>
  );
}
