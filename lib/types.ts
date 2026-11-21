// Shared contract. Change it only through the orchestrator: four agents build against it.

/** [ymin, xmin, ymax, xmax] on a 0 to 1000 scale, relative to the image. */
export type Box = [number, number, number, number];

export interface TourStop {
  n: number;
  label: string;
  says: string;
  box_2d: Box;
  confidence: string; // "hand-fixed" | "high" | "medium" | "low"
}

export interface Tour {
  title: string;
  overview: string;
  source?: string;
  image?: string; // local /public path when the figure is a prepared fixture
  stops: TourStop[];
  /** Charts only: "quick" is the light model's tour while the data is still being read; "full" is the data-built one. */
  stage?: "quick" | "full";
  /** Charts only: data read by the chart model and checked in code; the pointer scrubs it. Axis values in axis units. */
  chart?: {
    type: string;
    x: { label: string; unit: string | null; min: number | null; max: number | null; scale?: "linear" | "log"; ticks?: [number, number] };
    y: { label: string; unit: string | null; min: number | null; max: number | null; scale?: "linear" | "log"; ticks?: [number, number] };
    plot: Box;
    series: { name: string; color?: string; points: { x: number; y: number; label?: string; printed?: boolean }[] }[];
    /** Bar charts read per category: the pointer snaps to the nearest category (series[0] is "Total" on a stacked chart). */
    categories?: string[];
    stacked?: boolean;
  };
}

export type NodeKind = "section" | "figure" | "segment";

/** One stop for the reading cursor inside a node: the cursor moves heading -> block -> block, never a whole section at once. */
export interface Block {
  id: string; // "<node id>.b01" in order, assigned by code
  kind: "paragraph" | "item" | "equation" | "table" | "quote";
  text: string; // what is shown
  say?: string; // what is spoken when it differs from the text (math, tables)
}

export interface TwinNode {
  id: string; // "n01" in page order, assigned by code
  kind: NodeKind;
  order: number;
  level: number | null; // heading level for sections
  heading: string;
  text: string; // the node's whole text; blocks are the same text cut into cursor stops
  blocks?: Block[]; // when absent, lib/blocks.ts derives them from `text` (blank-line paragraphs)
  image?: { url: string; alt: string | null };
  tour?: Tour; // figure nodes that can be toured
  start?: number; // video segments: seconds
  end?: number;
  shown?: string; // video segments: what is on screen
  page?: number; // PDF nodes: 1-based page the node came from
}

export interface Twin {
  id: string;
  source: {
    url: string;
    kind: "page" | "pdf" | "video";
    title: string;
    via: "cache" | "browser-api" | "unlocker" | "gemini" | "direct" | "browser" | "open-copy" | "open-index"; // open-copy: a legal open copy of the paper; open-index: details and abstract from an open scholarly index
    credit?: string; // license and attribution line, shown on the twin
    private?: boolean; // sent from the student's own signed-in browser by the Arc helper: never cached to disk, never in a shareable link
    assessment?: boolean; // looks like a quiz or exam being taken: Arc reads it aloud but does not answer its questions
    lang?: string; // BCP 47 language of the text ("es", "ar", "ja"), from the page; absent means English
    dir?: "ltr" | "rtl"; // text direction, from the page or the language
    ms?: number; // time the fetch took
  };
  /** Videos only. Segments come from the video's own captions, in code; `shown` and headings arrive later from /api/video/shown. */
  video?: {
    id: string; // YouTube id
    duration: number; // seconds
    captions: "human" | "auto" | "none"; // "none": transcript made by Gemini instead
    enriched: boolean; // true once every segment has its heading and its on-screen description
  };
  /** PDFs only. The twin starts with the first page(s); /api/pdf/page serves the rest as the student reaches them. */
  pdf?: {
    id: string; // server id of the stored file
    pages: number; // total pages in the file
    outline?: { title: string; page: number; level: number }[]; // the whole document's sections, by code (lib/server/pdf.ts pdfOutline); level 1 is the top
  };
  /** Places the student can go from here on the same site (course modules, next and previous page), in page order. */
  links?: { label: string; url: string; rel?: "next" | "prev" | "up" }[];
  nodes: TwinNode[];
  counts: { sections: number; figures: number; segments: number }; // always computed in code
}
