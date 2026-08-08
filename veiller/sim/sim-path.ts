/**
 * Locate the Veiller miniapp simulator.
 *
 * The simulator lives in the Veiller monorepo (`sdk/miniapp-simulator`) because
 * it emulates the phone, not this miniapp. Turma is a separate repo, so point
 * `VEILLER_REPO` at a Veiller checkout — or keep the two side by side under one
 * git root, which is the default assumed here (including from inside a
 * `.turma/worktrees/<repo>/<id>` session worktree, whose repo root is four
 * levels down from the git root rather than one).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ENTRY = "sdk/miniapp-simulator/src/index.ts";

// Candidate Veiller checkouts, nearest first. `import.meta.dir` is
// `<turma>/veiller/sim`, so "../../.." is whatever directory holds the Turma
// checkout; the deeper hops cover a session worktree living at
// `<git-root>/.turma/worktrees/Turma/<id>`.
function candidateRoots(): string[] {
  const here = import.meta.dir;
  const roots: (string | undefined)[] = [process.env.VEILLER_REPO];
  for (const up of ["../../..", "../../../../../..", "../../../../../../.."]) {
    for (const name of ["Veiller", "veiller"]) {
      roots.push(resolve(here, up, name));
    }
  }
  return roots.filter((r): r is string => Boolean(r));
}

export function simulatorEntry(): string {
  const roots = candidateRoots();
  for (const root of roots) {
    const candidate = resolve(root, ENTRY);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not find the Veiller miniapp simulator (${ENTRY}).\n` +
      `Set VEILLER_REPO to a Veiller checkout, e.g.\n` +
      `  VEILLER_REPO=~/git/Veiller bun run sim/walkthrough.ts\n` +
      `Looked in: ${roots.join(", ")}`
  );
}

/**
 * The slice of the simulator's surface these scripts use. Declared structurally
 * because the module is loaded by path from a sibling checkout, so there is no
 * package to import types from.
 */
export interface SimulatorModule {
  Simulator: new (opts: {
    bundle: string;
    model?: string;
    userId?: string;
    storage?: Record<string, string>;
    verbose?: boolean;
    onTrace?: (entry: { kind: string; text: string; at: number }) => void;
  }) => SimulatorInstance;
  delay: (ms: number) => Promise<void>;
  silencePcm: (ms: number) => string;
  injectHostEnvironment: (
    html: string,
    opts: { packageName: string; socketPath: string; colorScheme?: "light" | "dark" }
  ) => string;
}

export interface SimulatorPhone {
  open(): void;
  close(): void;
  send(channel: string, payload?: unknown): void;
  request<T = unknown>(channel: string, payload?: unknown, timeoutMs?: number): Promise<T>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
  last<T = unknown>(channel: string): T | undefined;
  waitFor<T = unknown>(channel: string, predicate?: (p: T) => boolean, timeoutMs?: number): Promise<T>;
}

export interface SimulatorInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  tap(): boolean;
  doubleTap(): boolean;
  swipeUp(): boolean;
  swipeDown(): boolean;
  speak(opts?: { base64?: string; ms?: number; format?: string }): boolean;
  background(): void;
  foreground(): void;
  emit(streamType: string, data: unknown): boolean;
  lens(view?: "main" | "dashboard"): string;
  lensText(view?: "main" | "dashboard"): string[];
  settle(quietMs?: number, timeoutMs?: number): Promise<void>;
  waitFor(predicate: () => boolean, timeoutMs?: number, message?: string): Promise<void>;
  waitForLens(substring: string, timeoutMs?: number): Promise<void>;
  phone: SimulatorPhone;
  host: {
    activeSubscriptions(): string[];
    storageSnapshot(): Record<string, string>;
    unimplemented: string[];
  };
  glasses: { currentRevision(): number };
}

export async function simulatorModule(): Promise<SimulatorModule> {
  return (await import(simulatorEntry())) as unknown as SimulatorModule;
}

/**
 * The miniapp bundle to walk. `TURMA_BUNDLE` points at a packed release zip;
 * otherwise it's this checkout — the simulator finds `dist/` itself, so
 * `bun run build` first.
 */
export function bundlePath(): string {
  return process.env.TURMA_BUNDLE || resolve(import.meta.dir, "..");
}
