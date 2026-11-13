// Four small looping pictures of what Arc does with each kind of material, for the landing screen (components/Landing.tsx).
// Decorative: each is aria-hidden and the same idea is said in text beside it. Pure markup; motion and colour live in
// app/landing.css (theme variables only, stills under reduced motion).

/** A page: the ring moves heading, paragraph, heading, paragraph; a small marker follows the line being read. */
export function TextArt() {
  return (
    <svg
      className="lr-art lr-text"
      viewBox="0 0 320 200"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        className="lr-bar lr-head"
        x="32"
        y="26"
        width="128"
        height="10"
        rx="5"
      />
      <rect className="lr-bar" x="32" y="56" width="256" height="6" rx="3" />
      <rect className="lr-bar" x="32" y="70" width="236" height="6" rx="3" />
      <rect className="lr-bar" x="32" y="84" width="180" height="6" rx="3" />
      <rect
        className="lr-bar lr-head"
        x="32"
        y="116"
        width="104"
        height="10"
        rx="5"
      />
      <rect className="lr-bar" x="32" y="146" width="248" height="6" rx="3" />
      <rect className="lr-bar" x="32" y="160" width="220" height="6" rx="3" />
      <rect className="lr-bar" x="32" y="174" width="150" height="6" rx="3" />
      <rect className="lr-ring" x="20" y="46" width="280" height="54" rx="10" />
      <rect className="lr-mark" x="32" y="65" width="22" height="3" rx="1.5" />
    </svg>
  );
}

/** A block diagram: the ring is talked from part to part; each arrival is a soft pulse (the chime). */
export function FigureArt() {
  return (
    <svg
      className="lr-art lr-figure"
      viewBox="0 0 320 200"
      aria-hidden="true"
      focusable="false"
    >
      <path className="lr-wire" d="M112 40H208M250 58V112M216 58L112 120" />
      <rect className="lr-box" x="28" y="22" width="84" height="36" rx="8" />
      <rect className="lr-box" x="208" y="22" width="84" height="36" rx="8" />
      <rect className="lr-box" x="28" y="112" width="84" height="36" rx="8" />
      <rect className="lr-box" x="208" y="112" width="84" height="36" rx="8" />
      <text x="70" y="44" textAnchor="middle">
        Knee sensor
      </text>
      <text x="250" y="44" textAnchor="middle">
        Hub
      </text>
      <text x="70" y="134" textAnchor="middle">
        Belt unit
      </text>
      <text x="250" y="134" textAnchor="middle">
        Phone
      </text>
      <circle className="lr-pulse lr-p1" cx="70" cy="40" r="22" />
      <circle className="lr-pulse lr-p2" cx="250" cy="40" r="22" />
      <circle className="lr-pulse lr-p3" cx="70" cy="130" r="22" />
      <rect
        className="lr-ring"
        x="20"
        y="104"
        width="100"
        height="52"
        rx="12"
      />
      <line className="lr-rule" x1="20" y1="170" x2="300" y2="170" />
      <text className="lr-cap lr-go lr-c1" x="20" y="190">
        Move up.
      </text>
      <text className="lr-cap lr-at lr-c1" x="20" y="190">
        Right here. The knee sensor.
      </text>
      <text className="lr-cap lr-go lr-c2" x="20" y="190">
        Move right.
      </text>
      <text className="lr-cap lr-at lr-c2" x="20" y="190">
        Right here. The hub.
      </text>
      <text className="lr-cap lr-go lr-c3" x="20" y="190">
        Move down and to the left.
      </text>
      <text className="lr-cap lr-at lr-c3 lr-still" x="20" y="190">
        Right here. The belt unit.
      </text>
    </svg>
  );
}

/** A line chart: a marker sweeps one curve, a note beside it rises and falls with the height, a reading appears. */
export function ChartArt() {
  return (
    <svg
      className="lr-art lr-chart"
      viewBox="0 0 320 200"
      aria-hidden="true"
      focusable="false"
    >
      <path className="lr-axis" d="M40 30V160H284" />
      <path
        className="lr-tick"
        d="M36 61H40M36 116H40M112 160V164M184 160V164M256 160V164"
      />
      <text className="lr-small" x="34" y="64" textAnchor="end">
        45
      </text>
      <text className="lr-small" x="34" y="119" textAnchor="end">
        20
      </text>
      <text className="lr-small" x="184" y="178" textAnchor="middle">
        120
      </text>
      <text className="lr-small" x="284" y="178" textAnchor="end">
        sample
      </text>
      <polyline
        className="lr-series2"
        points="40,152 76,140 112,118 148,96 184,84 220,104 256,134 280,146"
      />
      <polyline
        className="lr-series"
        points="40,149 76,133.6 112,98.4 148,76.4 184,61 220,94 256,129.2 280,142.4"
      />
      <line className="lr-guide" x1="184" y1="61" x2="184" y2="160" />
      <circle className="lr-dot" cx="184" cy="61" r="5" />
      <circle className="lr-halo" cx="184" cy="61" r="10" />
      <line className="lr-track" x1="306" y1="30" x2="306" y2="160" />
      <rect className="lr-note" x="300" y="57" width="12" height="8" rx="4" />
      <text className="lr-small" x="306" y="178" textAnchor="middle">
        pitch
      </text>
      <text className="lr-read" x="44" y="22">
        At sample 120: about 45 degrees.
      </text>
    </svg>
  );
}

const PARTS = [
  ["Today: how the knee bends.", "A title card."],
  ["Here is the joint up close.", "A drawing of the knee."],
  ["Watch the angle change.", "A curve rising, then falling."],
  ["Three things to remember.", "A list of three points."],
];

/** A video: the playhead steps part to part and a card says what is said and what is on screen. */
export function VideoArt() {
  return (
    <svg
      className="lr-art lr-video"
      viewBox="0 0 320 200"
      aria-hidden="true"
      focusable="false"
    >
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          className="lr-seg"
          x={22 + i * 70}
          y="34"
          width="66"
          height="10"
          rx="5"
        />
      ))}
      {["0:00", "0:48", "1:35", "2:20"].map((t, i) => (
        <text key={t} className="lr-small" x={22 + i * 70} y="62">
          {t}
        </text>
      ))}
      <rect className="lr-ring" x="156" y="26" width="74" height="26" rx="13" />
      <rect className="lr-card" x="20" y="84" width="280" height="96" rx="12" />
      <text className="lr-label" x="38" y="114">
        Said
      </text>
      <text className="lr-label" x="38" y="156">
        On screen
      </text>
      {PARTS.map(([said, shown], i) => (
        <g
          key={said}
          className={`lr-part lr-v${i + 1}${i === 2 ? " lr-still" : ""}`}
        >
          <text x="38" y="132">
            {said}
          </text>
          <text x="38" y="172" className="lr-dim">
            {shown}
          </text>
        </g>
      ))}
    </svg>
  );
}
