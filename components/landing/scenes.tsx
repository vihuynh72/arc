// The scenes the landing plays (components/landing/Show.tsx): what the student does and what comes back, beat by beat, and the
// miniature each scene plays in. TODAY is what a screen reader is given by the demo paper, lecture and PDF as published; ARC is the
// same material in Arc. Every quoted line was read from the source or heard in the running product; none is written for effect.
// Pure markup and data: looks and motion live in app/landing.css.
import type { CSSProperties, ReactNode } from "react";

export type You = { keys?: string[]; say?: string; does?: string; done?: boolean };
export type Line = { who?: string; cue?: string; text?: string; tone?: boolean };
type Look = {
  cur: number; // where the reading cursor is; each view gives the number its meaning
  sent: number; // the sentence being spoken in that paragraph (-1: none)
  tour: boolean; // a figure tour is open
  stop: number; // the tour stop the ring is on (-1: none yet)
  sweep: boolean; // the student's pointer is crossing the chart
  play: boolean; // the lecture is playing
  drawn: boolean; // the lecturer has drawn the arrow
  pg: number; // which screenful of the paper is in view
  ask: "" | "listening" | "thinking" | "typing" | "done";
  typed: string; // what is in the ask box
  answer: boolean;
  verdict: boolean; // TODAY: the closing line is on
};
export type Beat = { ms: number; still?: boolean; you?: You | null; arc?: Line | null } & Partial<Look>;
export type Shown = Look & { you: You | null; arc: Line | null; youAt: number; arcAt: number };
export type Scene = {
  id: string;
  name: string;
  what: string;
  View: (p: { s: Shown }) => ReactNode;
  beats: Beat[];
  source?: string; // TODAY: where the quoted words come from
  open?: { label: string; url: string; then?: string; need?: string; next: string }; // ARC: the real thing behind the scene
};

const BASE: Look = { cur: 0, sent: -1, tour: false, stop: -1, sweep: false, play: false, drawn: false, pg: 0, ask: "", typed: "", answer: false, verdict: false };
/** Everything on screen at beat `b` of a scene: each beat only names what it changes. */
export function shown(scene: Scene, b: number): Shown {
  const s: Shown = { ...BASE, you: null, arc: null, youAt: 0, arcAt: 0 };
  scene.beats.slice(0, b + 1).forEach((beat, j) => {
    Object.assign(s, beat);
    if ("you" in beat) s.youAt = j;
    if ("arc" in beat) s.arcAt = j;
  });
  return s;
}

const PAPER = "https://www.mdpi.com/1424-8220/24/6/1935";
const LECTURE = "https://www.youtube.com/watch?v=4JqH55rLGKY";
const PDF = "https://arxiv.org/pdf/1706.03762";
const on = (v: boolean) => (v ? "" : undefined);

// ---------- Figure 1 of the paper: its real picture, and the first three stops of its hand-checked tour (fixtures/lower) ----------

type Box = [number, number, number, number]; // ymin, xmin, ymax, xmax on a 0 to 1000 scale, as the tour file has them
const BOXES: Box[] = [[222, 754, 438, 991], [536, 455, 636, 758], [643, 455, 743, 758]];
// One ring per stop, each drawn at its own size; moving on, the old ring is carried onto the new one's box while they cross-fade,
// so the eye sees one ring glide and change shape with nothing animated but transform and opacity.
const onto = (a: Box, b: Box) =>
  `translate(${(((b[1] - a[1]) / (a[3] - a[1])) * 100).toFixed(1)}%, ${(((b[0] - a[0]) / (a[2] - a[0])) * 100).toFixed(1)}%) scale(${((b[3] - b[1]) / (a[3] - a[1])).toFixed(3)}, ${((b[2] - b[0]) / (a[2] - a[0])).toFixed(3)})`;
const RINGS = BOXES.map(
  (b, i) =>
    ({
      top: `${b[0] / 10}%`,
      left: `${b[1] / 10}%`,
      width: `${(b[3] - b[1]) / 10}%`,
      height: `${(b[2] - b[0]) / 10}%`,
      "--from": i ? onto(b, BOXES[i - 1]) : "translate(30%, 30%) scale(0.4)",
      "--to": BOXES[i + 1] ? onto(b, BOXES[i + 1]) : "none",
    }) as CSSProperties,
);
const MID = BOXES.map((b) => [(b[1] + b[3]) / 20, (b[0] + b[2]) / 20]); // each stop's centre, in percent of the picture
const ARROW = "M1 1v16.5l4.2-3.6 2.9 6.6 2.6-1.1-2.9-6.5H14z";
const STOPS = [
  ["Stop 1 of 6: belt.", "It holds an IMU, an MCU, an RF module and a BLE module."],
  ["Stop 2 of 6: right thigh.", "It has an IMU, an MCU and an RF module."],
  ["Stop 3 of 6: right calf.", "The same three parts as the thigh."],
];
const CAPTION_1 = "System architecture ((left): wearing positions of devices (red dots), (right): schematic system diagram).";

function Picture({ s, box }: { s: Shown; box?: boolean }) {
  return (
    <div className="lx-pic" data-box={on(!!box && s.cur === 1)}>
      {/* On a narrow stage the tour looks at the half of the picture its stops are in (app/landing.css). */}
      <div className="lx-zoom">
        {/* eslint-disable-next-line @next/next/no-img-element -- the app's own small demo figure (public/fixtures), shown as the tour shows it */}
        <img src="/fixtures/lower/figure-1280.jpg" alt="" width={1280} height={459} loading="lazy" decoding="async" />
        {!box && RINGS.map((style, i) => <i key={i} className="lx-ring" data-at={i === s.stop ? "on" : i < s.stop ? "past" : "next"} style={style} />)}
        {!box && s.stop >= 0 && <i key={s.stop} className="lx-chime" style={{ top: `${MID[s.stop][1]}%`, left: `${MID[s.stop][0]}%` }} />}
        {/* Arc's own pointer goes to the part first; the ring follows (components/FigureTour.tsx). */}
        {!box && (
          <span className="lx-arrow" data-on={on(s.stop >= 0)} style={{ transform: `translate(${MID[Math.max(s.stop, 0)].join("%, ")}%)` }}>
            <svg viewBox="0 0 16 22" focusable="false">
              <path d={ARROW} />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}

function FigureArc({ s }: { s: Shown }) {
  return (
    <div className="lx-pad">
      <div className="lx-card">
        <Picture s={s} />
        <div className="lx-swap">
          <div className="lx-capn" data-on={on(!s.tour)}>
            <i className="lx-cursor" />
            <b>Figure 1.</b> {CAPTION_1}
          </div>
          <div className="lx-stopline" data-on={on(s.tour && s.stop < 0)}>
            Leg sensors send motion data by radio to a belt unit. The belt passes it by Bluetooth to a phone app. 6 stops.
          </div>
          {STOPS.map(([label, says], i) => (
            <div key={label} className="lx-stopline" data-on={on(s.stop === i)}>
              <b>{label}</b> {says}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FigureToday({ s }: { s: Shown }) {
  return (
    <div className="lx-pad lx-orig">
      <Picture s={s} box />
      <div className="lx-capn" data-box={on(s.cur === 2)}>
        <b>Figure 1.</b> {CAPTION_1}
      </div>
      <div className="lx-proof">
        <code className="lx-markup" data-on={on(s.cur >= 1)}>{'<img alt="Sensors 24 01935 g001">'}</code>
        <div className="lx-verdict" data-on={on(s.verdict)}>
          Six parts and how they connect: never said.
        </div>
      </div>
    </div>
  );
}

// ---------- Figure 20 of the paper, drawn from the values Arc read off it (two series, ten squats) ----------

const LEFT = [[0, 11], [6, 11], [7, 17], [28, 81], [43, 15], [60, 78], [76, 10], [94, 79], [108, 13], [128, 81], [145, 13], [163, 80], [177, 12], [197, 79], [211, 13], [231, 80], [245, 14], [265, 78], [279, 12.5], [299, 80], [313, 12.5], [334, 82], [349, 14], [374, 12]];
const RIGHT = [[0, -15], [6, -15.5], [7, 13], [28, 84], [43, 19], [60, 82], [76, 16], [94, 82], [108, 17], [128, 84], [145, 18], [163, 83], [177, 15], [178, -18], [182, -18.5], [183, 19], [197, 81], [211, 19], [231, 83], [245, 20], [265, 81], [279, 20], [299, 82], [313, 15], [314, -18.5], [317, -19], [318, 20], [334, 84], [348, 18], [349, -19], [355, -20], [374, -17.5]];
const X = (x: number) => +(44 + ((x + 18) / 411) * 546).toFixed(1);
const Y = (y: number) => +(206 - ((y + 25) / 115) * 190).toFixed(1);
const wave = (p: number[][]) =>
  p
    .map(([x, y], i) => {
      if (!i) return `M${X(x)} ${Y(y)}`;
      const m = +((X(p[i - 1][0]) + X(x)) / 2).toFixed(1);
      return `C${m} ${Y(p[i - 1][1])} ${m} ${Y(y)} ${X(x)} ${Y(y)}`;
    })
    .join("");

function Chart({ s, box }: { s: Shown; box?: boolean }) {
  return (
    <div className="lx-chart" data-box={on(!!box && s.cur === 1)} data-sweep={on(s.sweep)}>
      {/* On a narrow stage the chart is shown at reading size from its left edge: the first four squats (app/landing.css). */}
      <div className="lx-zoom">
        <svg viewBox="0 0 600 250" focusable="false">
          <text className="lx-t" x="44" y="11">
            squat join angles
          </text>
          <path className="lx-axis" d={`M44 16V206H590${[-20, 0, 20, 40, 60, 80].map((v) => `M40 ${Y(v)}H44`).join("")}${[0, 50, 100, 150, 200, 250, 300, 350].map((v) => `M${X(v)} 206V210`).join("")}`} />
          {[-20, 20, 60].map((v) => (
            <text key={v} className="lx-t" x="36" y={Y(v) + 4} textAnchor="end">
              {v}
            </text>
          ))}
          {[0, 100, 200, 300].map((v) => (
            <text key={v} className="lx-t" x={X(v)} y="224" textAnchor="middle">
              {v}
            </text>
          ))}
          <text className="lx-t" x="590" y="244" textAnchor="end">
            sample point #
          </text>
          <text className="lx-t" x="12" y="111" textAnchor="middle" transform="rotate(-90 12 111)">
            degree
          </text>
          <path className="lx-s2" d={wave(RIGHT)} />
          <path className="lx-s1" d={wave(LEFT)} />
          <path className="lx-s1" d="M44 241H56" />
          <text className="lx-t" x="60" y="245">
            left thigh angle
          </text>
          <path className="lx-s2" d="M148 241H160" />
          <text className="lx-t" x="164" y="245">
            right thigh angle
          </text>
        </svg>
        {/* The student's own mouse pointer, moved by transform across the plot (0 to 100% of this layer is the plot's width). */}
        {!box && (
          <span className="lx-mouse">
            <svg viewBox="0 0 16 22" focusable="false">
              <path d={ARROW} />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}

function ChartArc({ s }: { s: Shown }) {
  return (
    <div className="lx-pad">
      <div className="lx-card">
        <Chart s={s} />
        <div className="lx-swap">
          <div className="lx-stopline" data-on="">
            <span>squat join angles. A line chart with 2 series. 8 stops.</span>
            <b className="lx-readout" data-on={on(s.cur === 1)}>
              At sample point 130: left thigh angle about 81 degrees, right thigh angle about 84.
            </b>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartToday({ s }: { s: Shown }) {
  return (
    <div className="lx-pad lx-orig">
      <Chart s={s} box />
      <div className="lx-capn" data-box={on(s.cur === 2)}>
        <b>Figure 20.</b> Inclination angles.
      </div>
      <div className="lx-proof">
        <code className="lx-markup" data-on={on(s.cur >= 1)}>{'<img alt="Sensors 24 01935 g020">'}</code>
        <div className="lx-verdict" data-on={on(s.verdict)}>
          Two curves, ten squats, every value: never said.
        </div>
      </div>
    </div>
  );
}

// ---------- The lecture: its pie chart as the video shows it at 0:28 (Khan Academy, "Reading pie graphs") ----------

const MONTHS: [string, number][] = [["January", 18], ["February", 10], ["March", 7], ["April", 5], ["May", 5], ["June", 3], ["July", 3], ["August", 9], ["September", 7], ["October", 8], ["November", 13], ["December", 12]];
const at = (share: number, r: number) => [+(320 + r * Math.sin((share / 50) * Math.PI)).toFixed(1), +(196 - r * Math.cos((share / 50) * Math.PI)).toFixed(1)];
const SLICES = MONTHS.map(([name, v], i) => {
  const from = MONTHS.slice(0, i).reduce((n, m) => n + m[1], 0);
  const [a, b, c] = [at(from, 140), at(from + v, 140), at(from + v / 2, 98)];
  return { name, v, d: `M320 196L${a[0]} ${a[1]}A140 140 0 0 1 ${b[0]} ${b[1]}Z`, x: c[0], y: c[1] };
});

function Frame({ s }: { s: Shown }) {
  return (
    <div className="lx-frame" data-play={on(s.play)} data-drawn={on(s.drawn)}>
      <svg viewBox="0 0 640 360" focusable="false">
        <rect className="lx-board" width="640" height="360" />
        <text className="lx-chalk" x="320" y="36" textAnchor="middle">
          What are the best and worst months for cruise sales?
        </text>
        {SLICES.map((p, i) => (
          <path key={p.name} className={`lx-slice lx-c${i % 6}`} d={p.d} />
        ))}
        {SLICES.filter((p) => p.v >= 8).map((p) => (
          <text key={p.name} className="lx-month" x={p.x} y={p.y} textAnchor="middle">
            <tspan x={p.x}>{p.name}</tspan>
            <tspan x={p.x} dy="17">
              {p.v}%
            </tspan>
          </text>
        ))}
        <g className="lx-hand">
          <ellipse cx="378" cy="124" rx="22" ry="12" />
          <path d="M452 78c-8 10-17 18-26 24m0 0l3-13m-3 13l13-1" />
        </g>
      </svg>
      <span className="lx-state">
        <i />
        {s.play ? "Playing" : "Paused"}
      </span>
    </div>
  );
}

function LectureArc({ s }: { s: Shown }) {
  return (
    <div className="lx-pad lx-lect">
      <Frame s={s} />
      <div className="lx-part">
        <div className="lx-h3">Explaining the pie chart</div>
        <div className="lx-stamp">0:00 to 0:28</div>
        <div className="lx-said">The monthly data on ticket sales is shown below. What are the best and worst months for cruise sales?</div>
        <div className="lx-shownote">Shown on screen: A pie chart shows twelve monthly slices labeled clockwise: January 18%, February 10%, March 7%, April 5%, May 5%, June 3%, July 3%, August 9%, September 7%, October 8%, November 13%, and December 12%.</div>
      </div>
    </div>
  );
}

function LectureToday({ s }: { s: Shown }) {
  return (
    <div className="lx-pad lx-lect lx-orig">
      <Frame s={s} />
      <div className="lx-part">
        <div className="lx-h3">Reading pie graphs</div>
        <div className="lx-stamp">Lecture video, 0:28 to 1:00</div>
        <div className="lx-verdict" data-on={on(s.verdict)}>
          Which slice is blue, and how big it is: never said.
        </div>
      </div>
    </div>
  );
}

// ---------- Page 4 of the PDF: the paragraph before Equation 1, and the equation ----------

const EQ_SAID = "Equation 1: Attention of Q, K, V equals softmax of Q times K transpose over the square root of d sub k, times V.";

function Formula() {
  return (
    <span className="lx-eq">
      <span>
        Attention(<i>Q</i>, <i>K</i>, <i>V</i>) = softmax(
        <span className="lx-frac">
          <span>
            <i>QK</i>
            <sup>
              <i>T</i>
            </sup>
          </span>
          <span>
            √
            <span className="lx-root">
              <i>d</i>
              <sub>
                <i>k</i>
              </sub>
            </span>
          </span>
        </span>
        )<i>V</i>
      </span>
      <span>(1)</span>
    </span>
  );
}

function FormulaArc({ s }: { s: Shown }) {
  return (
    <div className="lx-page" data-pdf="">
      <div className="lx-stamp">Page 4</div>
      <div className="lx-p" data-here={on(s.cur === 0)}>
        <i className="lx-cursor" />
        <span>In practice, we compute the attention function on a set of queries simultaneously, packed together into a matrix Q. The keys and values are also packed together into matrices K and V. We compute the matrix of outputs as:</span>
      </div>
      <div className="lx-eqblock" data-here={on(s.cur === 1)}>
        <i className="lx-cursor" />
        <Formula />
        <span className="lx-eqsay">{EQ_SAID}</span>
      </div>
      <div className="lx-p">
        <span>The two most commonly used attention functions are additive attention [2], and dot-product (multiplicative) attention. Dot-product attention is identical to our algorithm, except for the scaling factor.</span>
      </div>
    </div>
  );
}

function FormulaToday({ s }: { s: Shown }) {
  return (
    <div className="lx-page lx-orig" data-pdf="">
      <div className="lx-p">
        <span>In practice, we compute the attention function on a set of queries simultaneously, packed together into a matrix Q. We compute the matrix of outputs as:</span>
      </div>
      <div className="lx-eqblock" data-box={on(s.cur === 1)}>
        <Formula />
      </div>
      <div className="lx-verdict" data-on={on(s.verdict)}>
        The fraction and the square root: gone.
      </div>
    </div>
  );
}

// ---------- The paper as Arc shows it: the Introduction, and the start of the Results ----------

const INTRO = [
  ["According to the research report of the World Health Organization (WHO), the proportion of elderly people with disabilities aged over 65 is close to 40%.", "In addition, the data of the WHO also point out that about 1 billion people around the globe suffer from some degree of life impairment due to neurodegenerative diseases, cerebrovascular diseases, neurological injuries, etc."],
  ["Maintaining proper posture and appropriate intensity of rehabilitation training is extremely important for patients after surgery due to aging, trauma, disease, stroke, or sports injuries.", "Within six months after the onset of cerebral stroke, through accurate and appropriate rehabilitation training, about 70–80% of patients can regain the ability to walk, and about 50–66% can live independently and have a certain quality of life [2]."],
  ["The conventional rehabilitation approach involves initial guidance by physical therapists in a hospital, followed by patients regularly performing rehabilitation exercises at home.", "Home exercise performance is typically assessed post hoc through patient self-reports, journals, and logs."],
];

function Intro({ s }: { s: Shown }) {
  return (
    <div className="lx-page" style={{ "--row": s.cur } as CSSProperties}>
      <div className="lx-eyebrow">Section 02</div>
      <div className="lx-h2">1. Introduction</div>
      <div className="lx-rows">
        <i className="lx-cursor" />
        {INTRO.map((sentences, i) => (
          <div key={i} className="lx-p">
            <span>
              {sentences.map((t, j) => (
                <span key={j} data-say={on(i === s.cur && j === s.sent)}>
                  {t}{" "}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Results({ s, here }: { s: Shown; here: number }) {
  return (
    <div className="lx-page">
      <div className="lx-eyebrow">Section 04</div>
      <div className="lx-h2" data-here={on(s.cur === here)}>
        <i className="lx-cursor" />
        3. Results
      </div>
      <div className="lx-h3">3.1. Hardware</div>
      <div className="lx-p lx-long" data-here={on(s.cur === here + 1)}>
        <i className="lx-cursor" />
        <span>The internal dimensions of the cases for the wearable devices were determined by the sizes of integrated modules. FreeCAD drawing software (ver. 0.21.1) was used to design these cases, and the prototypes were produced using a 3D printer. The RF-IMU-BLE device (ID 0) integrates a microcontroller module with RF communication, a microcontroller module with BLE, an IMU, a lithium battery charging module, and a lithium battery, as shown in Figure 12.</span>
      </div>
    </div>
  );
}

const Voice = ({ s }: { s: Shown }) => (
  <div className="lx-strip" style={{ "--pg": s.pg } as CSSProperties}>
    <Intro s={{ ...s, cur: 0 }} />
    <Results s={s} here={9} />
  </div>
);

const Question = ({ s }: { s: Shown }) => (
  <>
    <Results s={s} here={-1} />
    <div className="lx-answer" data-on={on(s.answer)}>
      <span>Answer</span>
      The belt unit contains an IMU, an MCU, an RF module, and a BLE module.
    </div>
  </>
);

// ---------- The two programmes ----------

const READER = "A screen reader";

export const TODAY: Scene[] = [
  {
    id: "t-figure",
    name: "A figure",
    what: "becomes a file name",
    View: FigureToday,
    source: "Quoted from the page’s own markup and caption for Figure 1 (mdpi.com/1424-8220/24/6/1935).",
    beats: [
      { ms: 800, cur: 0 },
      { ms: 2800, still: true, cur: 1, you: { does: "move to the picture" }, arc: { who: READER, text: "Sensors 24 01935 g001" } },
      { ms: 3400, still: true, cur: 2, you: { does: "move on, to its caption" }, arc: { who: READER, text: `Figure 1. ${CAPTION_1}` } },
      { ms: 2800, still: true, verdict: true, arc: { who: READER, cue: "nothing more" } },
    ],
  },
  {
    id: "t-chart",
    name: "A chart",
    what: "becomes a file name",
    View: ChartToday,
    source: "Quoted from the page’s own markup and caption for Figure 20 (mdpi.com/1424-8220/24/6/1935).",
    beats: [
      { ms: 800, cur: 0 },
      { ms: 2800, still: true, cur: 1, you: { does: "move to the chart" }, arc: { who: READER, text: "Sensors 24 01935 g020" } },
      { ms: 2400, still: true, cur: 2, you: { does: "move on, to its caption" }, arc: { who: READER, text: "Figure 20. Inclination angles." } },
      { ms: 2800, still: true, verdict: true, arc: { who: READER, cue: "nothing more" } },
    ],
  },
  {
    id: "t-lecture",
    name: "A lecture",
    what: "never says what is on screen",
    View: LectureToday,
    source: "Quoted from the lecture’s own audio, between 0:28 and 1:00 (Khan Academy, “Reading pie graphs”, youtube.com/watch?v=4JqH55rLGKY).",
    beats: [
      { ms: 800, drawn: true },
      { ms: 3800, still: true, play: true, you: { does: "play the lecture" }, arc: { who: "The lecturer", text: "So for example, this blue slice over here represents the sales in January." } },
      { ms: 3200, still: true, play: false, verdict: true, arc: { who: READER, cue: "silence: the picture has no words in it to read" } },
    ],
  },
  {
    id: "t-formula",
    name: "A formula",
    what: "comes out scrambled",
    View: FormulaToday,
    source: "Quoted from the PDF’s own text for Equation 1, in the order the file stores it (arxiv.org/pdf/1706.03762, page 4).",
    beats: [
      { ms: 800, cur: 0 },
      { ms: 3600, still: true, cur: 1, you: { does: "move to the formula" }, arc: { who: READER, text: "QKT Attention(Q, K, V ) = softmax( √ )V (1) dk" } },
      { ms: 2800, still: true, verdict: true },
    ],
  },
];

export const ARC: Scene[] = [
  {
    id: "figure",
    name: "A figure",
    what: "toured part by part",
    View: FigureArc,
    open: { label: "Tour this figure", url: PAPER, then: "tour figure 1", need: "figure[data-node-id]", next: "The tour plays by itself. Press P to pause, or Right Arrow to go at your own pace." },
    beats: [
      { ms: 800 },
      { ms: 500, you: { keys: ["Enter"], does: "start the tour" } },
      { ms: 3000, still: true, tour: true, arc: { text: "Leg sensors send motion data by radio to a belt unit. The belt passes it by Bluetooth to a phone app. 6 stops. I will go through the parts." } },
      { ms: 2700, still: true, stop: 0, arc: { cue: "chime", text: "Start at the top right. Belt. It holds an IMU, an MCU, an RF module and a BLE module." } },
      { ms: 2700, still: true, stop: 1, arc: { cue: "chime", text: "Move far down and to the left. Right thigh. It has an IMU, an MCU and an RF module." } },
      { ms: 2300, still: true, stop: 2, arc: { cue: "chime", text: "Move down. Right calf. The same three parts as the thigh." } },
    ],
  },
  {
    id: "chart",
    name: "A chart",
    what: "heard as a curve, read as numbers",
    View: ChartArc,
    open: { label: "Open this chart", url: PAPER, then: "tour figure 20", need: "figure[data-node-id]", next: "Then move your pointer across the chart." },
    beats: [
      { ms: 800, tour: true },
      { ms: 3000, sweep: true, you: { does: "move the pointer across the chart" }, arc: { cue: "a tone rises and falls with the curve", tone: true } },
      { ms: 3600, still: true, cur: 1, arc: { text: "At sample point 130: left thigh angle about 81 degrees, right thigh angle about 84." } },
    ],
  },
  {
    id: "lecture",
    name: "A lecture",
    what: "with what is on screen",
    View: LectureArc,
    open: { label: "Open this lecture", url: LECTURE, next: "Then press P to play." },
    beats: [
      { ms: 800 },
      { ms: 500, you: { keys: ["P"], does: "play the lecture" } },
      { ms: 3000, still: true, play: true, arc: { who: "The lecturer", text: "The monthly data on ticket sales is shown below. What are the best and worst months for cruise sales?" } },
      { ms: 3400, still: true, play: false, drawn: true, arc: { cue: "the video pauses", text: "On screen: A pie chart shows twelve monthly slices labeled clockwise: January 18%, February 10%, March 7% …" } },
      { ms: 2800, still: true, arc: { text: "The speaker draws a yellow arrow pointing to the blue January 18% slice." } },
      { ms: 2600, still: true, play: true, arc: { who: "The lecturer", text: "So for example, this blue slice over here represents the sales in January." } },
    ],
  },
  {
    id: "formula",
    name: "A formula",
    what: "spoken as math",
    View: FormulaArc,
    open: { label: "Open this PDF", url: PDF, then: "go to section 3.2.1", need: "article[data-pdf]", next: "Then press E for the equation." }, // the section the formula is in ("go to page 4" landed at the top of the page, on something else)
    beats: [
      { ms: 800, cur: 0 },
      { ms: 1700, arc: { text: "… We compute the matrix of outputs as:" } },
      { ms: 500, you: { keys: ["↓"], does: "next paragraph" }, arc: null },
      { ms: 4400, still: true, cur: 1, arc: { text: EQ_SAID } },
    ],
  },
  {
    id: "page",
    name: "A page",
    what: "read paragraph by paragraph",
    View: Intro,
    open: { label: "Open this paper", url: PAPER, next: "Then press Down to read on." },
    beats: [
      { ms: 800, cur: 0 },
      { ms: 2200, still: true, sent: 0, arc: { text: "According to the research report of the World Health Organization (WHO), the proportion of elderly people …" } },
      { ms: 500, you: { keys: ["↓"], does: "next paragraph" }, arc: null, sent: -1 },
      { ms: 2200, still: true, cur: 1, sent: 0, arc: { text: "Maintaining proper posture and appropriate intensity of rehabilitation training is extremely important …" } },
      { ms: 1900, still: true, sent: 1, arc: { text: "Within six months after the onset of cerebral stroke, through accurate and appropriate rehabilitation training …" } },
      { ms: 500, you: { keys: ["↓"], does: "next paragraph" }, arc: null, sent: -1 },
      { ms: 2200, still: true, cur: 2, sent: 0, arc: { text: "The conventional rehabilitation approach involves initial guidance by physical therapists in a hospital …" } },
    ],
  },
  {
    id: "voice",
    name: "A spoken request",
    what: "Arc goes where you say",
    View: Voice,
    open: { label: "Open this paper", url: PAPER, next: "Then hold Space and say: take me to the results." },
    beats: [
      { ms: 800, cur: 0 },
      { ms: 2200, ask: "listening", you: { keys: ["Space"], say: "take me to the results" } },
      { ms: 500, ask: "thinking" },
      { ms: 2800, still: true, ask: "done", pg: 1, cur: 9, arc: { text: "3 Results" } },
    ],
  },
  {
    id: "question",
    name: "A question",
    what: "answered from the page",
    View: Question,
    open: { label: "Open this paper", url: PAPER, next: "Then press / and type a question, or hold Space and ask." },
    beats: [
      { ms: 800, cur: 0 },
      { ms: 2300, ask: "typing", typed: "what does the belt unit contain", you: { keys: ["/"], does: "type a question" } },
      { ms: 600, ask: "thinking", typed: "", you: { keys: ["Enter"], say: "what does the belt unit contain", done: true } },
      { ms: 3600, still: true, ask: "done", answer: true, arc: { text: "The belt unit contains an IMU, an MCU, an RF module, and a BLE module." } },
    ],
  },
];
