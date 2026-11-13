// Renders twin nodes as plain semantic HTML. Used by components/Twin.tsx.
import FigureTour from "@/components/FigureTour";
import RemoteView from "@/components/RemoteView";
import { clock } from "@/lib/client/reader";
import type { TwinNode } from "@/lib/types";

type Props = {
  nodes: TwinNode[];
  pageUrl?: string; // set for web pages only: lets each figure open the real page
  tourId: string | null;
  onTour: (node: TwinNode) => void;
  onLeave: (node: TwinNode) => void;
};

const paragraphs = (text: string) => text.split(/\n{2,}/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>);

export default function Nodes({ nodes, pageUrl, tourId, onTour, onLeave }: Props) {
  let figureNo = 0;
  return nodes.map((n) => {
    if (n.kind === "figure") {
      figureNo++;
      return (
        <figure key={n.id} id={`fig-${n.id}`} tabIndex={-1} data-node-id={n.id}>
          {n.image && (
            // eslint-disable-next-line @next/next/no-img-element -- remote publisher image, shown as-is
            <img src={n.image.url} alt={n.image.alt ?? n.heading} referrerPolicy="no-referrer" />
          )}
          <figcaption data-cursor>
            <strong>{n.heading}.</strong> {n.text}
          </figcaption>
          {tourId === n.id && n.tour ? (
            <div data-tour>
              <FigureTour node={n} onLeave={() => onLeave(n)} />
            </div>
          ) : (
            <button type="button" onClick={() => onTour(n)}>
              Tour this figure
            </button>
          )}
          {pageUrl && <RemoteView url={pageUrl} figure={figureNo} />}
        </figure>
      );
    }
    const level = Math.min(Math.max(n.level ?? (n.kind === "segment" ? 3 : 2), 2), 4);
    const H = `h${level}` as "h2" | "h3" | "h4";
    return (
      <div key={n.id} data-node-id={n.id}>
        <H data-cursor>{n.heading}</H>
        {n.kind === "segment" && n.start != null && (
          <p className="stamp">
            {clock(n.start)}
            {n.end != null ? ` to ${clock(n.end)}` : ""}
          </p>
        )}
        {paragraphs(n.text)}
        {n.shown && <p className="shown">Shown on screen: {n.shown}</p>}
      </div>
    );
  });
}
