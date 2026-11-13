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
}

export type NodeKind = "section" | "figure" | "segment";

export interface TwinNode {
  id: string; // "n01" in page order, assigned by code
  kind: NodeKind;
  order: number;
  level: number | null; // heading level for sections
  heading: string;
  text: string; // what the reader voice speaks for this node
  image?: { url: string; alt: string | null };
  tour?: Tour; // figure nodes that can be toured
  start?: number; // video segments: seconds
  end?: number;
  shown?: string; // video segments: what is on screen
}

export interface Twin {
  id: string;
  source: {
    url: string;
    kind: "page" | "pdf" | "video";
    title: string;
    via: "cache" | "browser-api" | "unlocker" | "gemini" | "direct" | "browser";
    credit?: string; // license and attribution line, shown on the twin
    ms?: number; // time the fetch took
  };
  nodes: TwinNode[];
  counts: { sections: number; figures: number; segments: number }; // always computed in code
}
