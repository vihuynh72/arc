"use client";
// "Blindness is a spectrum" (components/Landing.tsx): one real study page under six impressions of sight, built from CSS layers
// over a miniature of the demo paper. Impressions, not a medical simulation. The picture is decoration (aria-hidden, inert); the six
// buttons carry the names and the one-line descriptions. Where part of the view is missing, it follows the visitor's pointer.
import { useRef, useState } from "react";
import { rove } from "./rove";

const SIGHTS = [
  ["full", "Full sight", "The page as its authors drew it."],
  ["blur", "Low acuity", "Detail goes first. Shapes stay; print does not."],
  ["centre", "Central loss", "The middle is missing: the part the eyes point at."],
  ["tunnel", "Tunnel vision", "One small clear window. A page becomes many small looks."],
  ["glare", "Glare and low contrast", "A bright page washes out. Pale print goes first."],
  ["none", "No usable sight", "Nothing on the screen helps. The page has to be heard."],
];

export default function Spectrum() {
  const [at, setAt] = useState(1);
  const veil = useRef<HTMLDivElement>(null);
  return (
    <div
      className="sx"
      // On the wrapper: the picture itself is inert, and an inert box gets no pointer events.
      onPointerMove={(e) => {
        const v = veil.current;
        if (!v) return;
        const r = v.getBoundingClientRect();
        const share = (at: number, from: number, size: number) => `${((Math.min(1, Math.max(0, (at - from) / size)) - 0.5) * 100) / 3}%`;
        v.style.setProperty("--mx", share(e.clientX, r.left, r.width)); // the moving layers are three times the view: a third of a percent each
        v.style.setProperty("--my", share(e.clientY, r.top, r.height));
      }}
    >
      <div className="sx-view" aria-hidden="true" inert>
        <div className="sx-page">
          <div className="sx-journal">Sensors 2024, 24(6), 1935</div>
          <div className="sx-title">Development of Wearable Devices for Collecting Digital Rehabilitation/Fitness Data from Lower Limbs</div>
          <div className="sx-text">
            Lower extremity exercises are considered a standard and necessary treatment for rehabilitation and a well-rounded fitness routine, which builds strength, flexibility, and balance. The efficacy of rehabilitation programs hinges on meticulous monitoring of both adherence to home exercise routines and the quality of performance.
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- the app's own small demo figure (public/fixtures) */}
          <img src="/fixtures/lower/figure-1280.jpg" alt="" width={1280} height={459} loading="lazy" decoding="async" />
          <div className="sx-cap">
            <b>Figure 1.</b> System architecture ((left): wearing positions of devices (red dots), (right): schematic system diagram).
          </div>
        </div>
        <div ref={veil} className="sx-veil" data-sight={SIGHTS[at][0]}>
          <i className="sx-blur" />
          <i className="sx-centre" />
          <i className="sx-tunnel" />
          <i className="sx-glare" />
          <i className="sx-none" />
        </div>
      </div>
      <div className="sx-list" role="toolbar" aria-label="Kinds of sight" aria-orientation="vertical" onKeyDown={rove}>
        {SIGHTS.map(([id, name, says], i) => (
          <button key={id} type="button" aria-label={`${name}: ${says.replace(/\.$/, "")}`} aria-pressed={i === at} tabIndex={i === at ? 0 : -1} onClick={() => setAt(i)}>
            <span>{name}</span>
            <small>{says}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
