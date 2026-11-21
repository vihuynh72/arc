"use client";
// The picture of a PDF figure node (components/twin/Nodes.tsx). Before the figure has a box: a quiet placeholder of a typical
// figure's height. With one: the stored picture, drawn here from the page first if the server has none (lib/client/pdfFigure.ts),
// and only once the figure is within about a screen of the viewport. The caption stays in the figcaption beneath.
// PdfEquation: the same for a formula (a PDF equation stays an equation block; this only adds its picture above the spoken words).
import { useEffect, useRef, useState } from "react";
import { ensureFigure } from "@/lib/client/pdfFigure";
import type { TwinNode } from "@/lib/types";

const WAIT: React.CSSProperties = { minHeight: "14rem", display: "grid", placeItems: "center", border: "1px dashed currentColor", opacity: 0.6, borderRadius: 6 };

export default function PdfFigure({ node }: { node: TwinNode }) {
  const url = node.image?.url;
  const box = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!url || !box.current) return;
    let live = true;
    const el = box.current;
    const seen = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        seen.disconnect();
        ensureFigure(url, el.clientWidth || 640).then(
          (u) => live && setSrc(u),
          () => live && setFailed(true),
        );
      },
      { rootMargin: "100% 0px" },
    );
    seen.observe(el);
    return () => {
      live = false;
      seen.disconnect();
    };
  }, [url]);

  if (src) {
    return (
      <div className="figpic">
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored cut-out of the PDF page, served by this app */}
        <img src={src} alt={node.image?.alt ?? node.heading} />
      </div>
    );
  }
  return (
    <div ref={box} style={WAIT} aria-hidden="true">
      {failed ? "The picture could not be drawn." : "Getting the picture."}
    </div>
  );
}

/** An equation block (the <p> the reading cursor stops on): the formula's picture, then the words that are spoken, smaller. The picture's
 * room is reserved from the first render (its size is in the URL), so nothing moves when it arrives; while it is being cut the words
 * show, and if cutting fails the words stay on their own. The words are hidden from a screen reader once the picture, whose alt is the
 * same words, is there. Nothing here speaks or takes focus. */
export function PdfEquation({ node, id, text }: { node: TwinNode; id: string; text: string }) {
  const url = node.image!.url;
  const box = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const size = /[?&]size=(\d+)x(\d+)/.exec(url);

  useEffect(() => {
    if (!box.current) return;
    let live = true;
    const seen = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        seen.disconnect();
        ensureFigure(url, 0).then(
          (u) => live && setSrc(u),
          () => live && setFailed(true),
        );
      },
      { rootMargin: "100% 0px" },
    );
    seen.observe(box.current);
    return () => {
      live = false;
      seen.disconnect();
    };
  }, [url]);

  return (
    <p data-block-id={id} data-kind="equation">
      {failed ? (
        text
      ) : (
        <>
          <span ref={box} className="eqpic" style={size ? ({ "--eq-w": size[1], "--eq-ar": `${size[1]} / ${size[2]}` } as React.CSSProperties) : undefined} aria-hidden={src ? undefined : true}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a stored cut-out of the PDF page, served by this app */}
            {src && <img src={src} alt={node.image?.alt ?? text} onError={() => setFailed(true)} />}
          </span>
          <span className="eq-say" aria-hidden={src ? true : undefined}>
            {text}
          </span>
        </>
      )}
    </p>
  );
}
