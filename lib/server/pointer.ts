// Moves the real macOS mouse pointer for the reading cursor, when Arc runs on the student's own Mac.
// scripts/pointer.swift is compiled once into .cache/ and kept running; it warps the pointer and posts no clicks or keys.
// shortcut: macOS only and only for a browser on this same machine, add a Windows/Linux helper when one is needed.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const g = globalThis as unknown as { arcPointer?: ChildProcessWithoutNullStreams | null };
const SRC = path.join(process.cwd(), "scripts", "pointer.swift");
const BIN = path.join(process.cwd(), ".cache", "arc-pointer");

// Off unless the person at this Mac asks for it: taking someone's mouse must never be a surprise.
export const pointerAvailable = () => process.platform === "darwin" && process.env.ARC_REAL_POINTER === "on" && existsSync(SRC);

function helper(): ChildProcessWithoutNullStreams | null {
  if (!pointerAvailable()) return null;
  if (g.arcPointer && g.arcPointer.exitCode === null) return g.arcPointer;
  try {
    if (!existsSync(BIN) || statSync(BIN).mtimeMs < statSync(SRC).mtimeMs) {
      mkdirSync(path.dirname(BIN), { recursive: true });
      execFileSync("swiftc", ["-O", SRC, "-o", BIN], { stdio: "ignore", timeout: 120_000 });
    }
    const p = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    p.on("exit", () => { if (g.arcPointer === p) g.arcPointer = null; });
    p.stdout.resume(); p.stderr.resume();
    return (g.arcPointer = p);
  } catch {
    return (g.arcPointer = null);
  }
}

/** Glide the real pointer to a screen point. False when this machine cannot do it. */
export function movePointer(x: number, y: number, ms = 350): boolean {
  const ok = [x, y, ms].every(Number.isFinite) && x >= -8000 && x <= 16000 && y >= -8000 && y <= 16000;
  const p = ok ? helper() : null;
  if (!p) return false;
  p.stdin.write(`${Math.round(x)} ${Math.round(y)} ${Math.min(Math.max(Math.round(ms), 0), 1500)}\n`);
  return true;
}
