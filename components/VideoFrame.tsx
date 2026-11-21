"use client";
// A still picture from a lecture video, inside its part of the transcript (components/twin/Nodes.tsx), and the tour of it.
// The 16:9 box exists from the moment the picture is known, so nothing below it moves when the image loads. The tour is the
// figure tour (components/FigureTour.tsx) started the way a figure's is: Twin.startTour reads node.image.url.
import FigureTour from "@/components/FigureTour";
import { clock } from "@/lib/client/reader";
import type { TwinNode } from "@/lib/types";

type Props = { node: TwinNode; touring: boolean; onTour: (node: TwinNode) => void; onLeave: (node: TwinNode) => void };

export default function VideoFrame({ node, touring, onTour, onLeave }: Props) {
  const u = new URL(node.image!.url); // Nodes renders this only for a part with a picture
  const at = Number(u.searchParams.get("at"));
  return (
    <div className="vframe" id={`fig-${node.id}`} tabIndex={-1} data-touring={touring ? "" : undefined}>
      {touring ? (
        <div data-tour>
          <FigureTour node={node} onLeave={() => onLeave(node)} />
        </div>
      ) : (
        <>
          {/* A click on the picture tours it; by keys, Enter on this part (components/Reader.tsx). */}
          <div className="vframe-pic" data-tour-pic="" onClick={() => onTour(node)}>
            {/* alt is empty: the words of "Shown on screen" next to it say what is in it, and a screen reader should not read them twice */}
            {/* eslint-disable-next-line @next/next/no-img-element -- a still from this app's own frame route */}
            <img src={`/api/video/frame${u.search}`} alt="" width={1280} height={720} loading="lazy" />
          </div>
          <p className="vframe-note">
            Picture from the video at{" "}
            <button type="button" className="vframe-at" aria-label={`Go to ${clock(at)} in the video`} onClick={() => window.dispatchEvent(new CustomEvent("arc:seek", { detail: at }))}>
              {clock(at)}
            </button>
            . <span className="tour-hint" aria-hidden="true">Click the picture for a guided tour.</span>
          </p>
        </>
      )}
    </div>
  );
}
