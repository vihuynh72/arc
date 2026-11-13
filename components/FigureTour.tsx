"use client";
// OWNER: tour agent. Stub.
import type { TwinNode } from "@/lib/types";

export default function FigureTour({ node, onLeave }: { node: TwinNode; onLeave: () => void }) {
  return (
    <div>
      <p>Tour of {node.heading} is not built yet.</p>
      <button onClick={onLeave}>Leave tour</button>
    </div>
  );
}
