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
