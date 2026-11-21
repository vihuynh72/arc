// Renders twin nodes as plain semantic HTML. Used by components/Twin.tsx.
import { Fragment } from "react";
import FigureTour from "@/components/FigureTour";
import PdfFigure, { PdfEquation } from "@/components/PdfFigure";
import VideoFrame from "@/components/VideoFrame";
import { blocksOf, isText } from "@/lib/blocks";
import { clock, splitSentences } from "@/lib/client/reader";
import type { Block, TwinNode } from "@/lib/types";

type Props = {
  nodes: TwinNode[];
  pageUrl?: string; // unused since the Live page panel shows the figure on the real page
  tourId: string | null;
  onTour: (node: TwinNode) => void;
  onLeave: (node: TwinNode) => void;
};

// A block is one reading-cursor stop. Its sentences are spans so the one being spoken can be marked (components/Reader.tsx);
// a block whose spoken words differ from its text (math, tables) is shown whole.
// An equation shows the formula itself, large, with its spoken form in a smaller line under it (low vision reads the formula, hears the words).
const block = (b: Block) => (
  <p key={b.id} data-block-id={b.id} data-kind={b.kind}>
    {b.kind === "equation" && b.say && b.say.trim() !== b.text.trim() ? (
      <>
        <span className="eq">{b.text}</span>
        <span className="eq-say">{b.say}</span>
      </>
    ) : b.say || b.kind === "table" || b.kind === "equation" ? b.text : splitSentences(b.text).map((s, k) => (
        <Fragment key={k}>
          {k ? " " : ""}
          <span data-s={k}>{s}</span>
        </Fragment>
      ))}
  </p>
);

// The figure's own label ("Figure 2", "Table 1") from its heading or the start of its caption, for the card's small heading
// (app/globals.css), so the card never says "Figure 1" above a caption that starts "Figure 2". None: the card counts.
const LABEL = /^(fig(?:ure)?s?\.?|table|chart|scheme|plate|graph)\s*([A-Z]?\d+[a-z]?(?:\.\d+)*)\b/i;
export const figureLabel = (n: Pick<TwinNode, "heading" | "text" | "page">) => {
  if (n.page != null) return n.heading.trim() || undefined; // a PDF figure's heading is the paper's own label ("Figure 2", "Figure on page 4")
  const m = LABEL.exec(n.heading.trim()) ?? LABEL.exec(n.text.trim());
  return m ? `${/^fig/i.test(m[1]) ? "Figure" : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()} ${m[2]}` : undefined;
};

const paragraphs = (text: string) => text.split(/\n{2,}/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>);

export default function Nodes({ nodes, tourId, onTour, onLeave }: Props) {
  return nodes.map((n, k) => {
    const stamp = n.page != null && n.page !== nodes[k - 1]?.page ? <p className="stamp" key={`pg${n.page}`}>Page {n.page}</p> : null;
    if (n.kind === "figure") {
      return (
        <Fragment key={n.id}>
        {stamp}
        <figure id={`fig-${n.id}`} tabIndex={-1} data-node-id={n.id} data-label={figureLabel(n)}>
          {/* While its tour is open the tour shows the image with the ring; one image, not two. A click on the picture moves the
              cursor here and starts the tour (components/Reader.tsx "tour"); keys: Enter on the figure. No control in the Tab order. */}
          {!(tourId === n.id && n.tour) && (n.page != null || n.image) && (
            <div data-tour-pic={n.image ? "" : undefined} onClick={n.image ? () => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "tour", args: { id: n.id } } })) : undefined}>
              {n.page != null ? (
                <PdfFigure node={n} />
              ) : (
                <div className="figpic">
                  {/* eslint-disable-next-line @next/next/no-img-element -- remote publisher image, shown as-is */}
                  <img src={n.image!.url} alt={n.image!.alt ?? n.heading} referrerPolicy="no-referrer" />
                </div>
              )}
              {n.image && <small className="tour-hint" aria-hidden="true">Click the picture for a guided tour.</small>}
            </div>
          )}
          <figcaption data-cursor>
            <strong>{n.heading}.</strong> {n.text}
          </figcaption>
          {tourId === n.id && n.tour && (
            <div data-tour>
              <FigureTour node={n} onLeave={() => onLeave(n)} />
            </div>
          )}
        </figure>
        </Fragment>
      );
    }
    const level = Math.min(Math.max(n.level ?? (n.kind === "segment" ? 3 : 2), 2), 4);
    const H = `h${level}` as "h2" | "h3" | "h4";
    return (
      <Fragment key={n.id}>
      {stamp}
      <div data-node-id={n.id}>
        {/* A lecture's parts (all level 3, lib/server/video.ts) sit right under its h1: level 2 to assistive technology, h3 look kept. */}
        {!isText(n) && <H data-cursor aria-level={n.kind === "segment" ? 2 : undefined}>{n.heading}</H>}
        {n.kind === "segment" && n.start != null && (
          <p className="stamp">
            {clock(n.start)}
            {n.end != null ? ` to ${clock(n.end)}` : ""}
          </p>
        )}
        {/* The picture sits right under the time, so heading and picture are on screen together whatever the words' length. */}
        {n.kind === "segment" && n.image && <VideoFrame node={n} touring={tourId === n.id && !!n.tour} onTour={onTour} onLeave={onLeave} />}
        {/* A PDF equation is an equation block: its words, and above them its picture when the server has a checked box for it
            (n.image on a section is that picture, not a figure: only kind "figure" is toured, counted or offered as one). */}
        {n.kind === "section"
          ? blocksOf(n).map((b) => {
              const eq = isText(n) && /^equation$/i.test(n.heading.trim());
              return eq && n.image ? <PdfEquation key={b.id} node={n} id={b.id} text={b.text} /> : block(eq ? { ...b, kind: "equation" } : b);
            })
          : paragraphs(n.text)}
        {n.shown && <p className="shown">Shown on screen: {n.shown}</p>}
      </div>
      </Fragment>
    );
  });
}
