/**
 * A step-by-step tour of the Turma miniapp on simulated G2 glasses.
 *
 * Every screen, gesture and hub round-trip the app is supposed to have, driven
 * through the Veiller miniapp simulator against `fake-hub.ts` — the real built
 * bundle, the real display pipeline, the real REST/WebSocket contract. Each
 * step prints the lens and asserts what should be on it; a failed assertion is
 * a finding, and any finding makes the run exit non-zero, so this doubles as a
 * regression check.
 *
 *   bun run build              # the harness walks dist/, not src/
 *   bun run sim/walkthrough.ts
 *   bun run sim/walkthrough.ts --step 9   # stop after step 9
 *   bun run sim/walkthrough.ts --verbose  # mirror the miniapp console
 */

import { CONFIG_STORAGE_KEY } from "../src/core/config.ts";
import { defaultFleet, FakeHub, runningSession } from "./fake-hub.ts";
import { bundlePath, simulatorModule, type SimulatorInstance } from "./sim-path.ts";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const stopAfter = Number(value("step") ?? "0") || Infinity;
const verbose = flag("verbose");

const findings: string[] = [];
let stepNo = 0;

function check(ok: boolean, what: string): void {
  if (ok) {
    console.log(`    ✓ ${what}`);
    return;
  }
  console.log(`    ✗ ${what}`);
  findings.push(`step ${stepNo}: ${what}`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Everything currently on the lens, as one string. */
function screen(sim: SimulatorInstance): string {
  return sim.lensText().join("\n");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `label` is the row the cursor is on. */
function onRow(sim: SimulatorInstance, label: string): boolean {
  return new RegExp(`> ${escapeRe(label)}`).test(screen(sim));
}

/**
 * Swipe down until the cursor lands on `label`. Settles after each gesture —
 * the display debounces same-shape frames by 120ms, so reading the lens
 * without settling walks straight past the row.
 */
async function moveTo(sim: SimulatorInstance, label: string, max = 12): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (onRow(sim, label)) return true;
    sim.swipeDown();
    await sim.settle();
  }
  return onRow(sim, label);
}

/**
 * Wait until no flash notice is on screen. Every screen's header line is
 * borrowed by an active flash for FLASH_DURATION_MS, so an assertion about a
 * screen's title has to let the last action's notice expire first.
 */
async function calm(sim: SimulatorInstance): Promise<void> {
  await sim.waitFor(
    () => !/queued|unreachable|session ended/.test(screen(sim)),
    8000,
    "a flash notice never expired"
  );
  await sim.settle();
}

function showLens(sim: SimulatorInstance): void {
  console.log(
    sim
      .lens()
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n")
  );
}

async function main(): Promise<void> {
  const hub = new FakeHub();
  hub.start();
  hub.agents = defaultFleet();

  const { Simulator } = await simulatorModule();
  const sim = new Simulator({
    bundle: bundlePath(),
    model: "g2",
    verbose,
    // A short poll so a walkthrough step doesn't wait out the 6s production
    // cadence for the fleet change it just made.
    storage: {},
  });

  const config = {
    hubUrl: hub.url,
    user: hub.user,
    password: hub.password,
    pollMs: 400,
  };

  /** Wait for a poll to land the fleet change we just made. */
  const poll = async (times = 2): Promise<void> => {
    await delay(config.pollMs * times + 250);
    await sim.settle();
  };

  const step = async (title: string, run: () => Promise<void>): Promise<boolean> => {
    stepNo += 1;
    if (stepNo > stopAfter) return false;
    console.log(`\n${String(stepNo).padStart(2)}. ${title}`);
    await run();
    showLens(sim);
    return true;
  };

  try {
    await sim.start();

    // ---------------------------------------------------------------- 1
    if (
      !(await step("Cold boot with no credentials shows the setup screen", async () => {
        await sim.settle();
        const s = screen(sim);
        check(s.includes("TURMA"), "the lens names the app");
        check(s.includes("Set up on your phone"), "it points the operator at the phone page");
        check(hub.calls.length === 0, "a signed-out app makes no hub calls");
      }))
    )
      return;

    // ---------------------------------------------------------------- 2
    if (
      !(await step("Signing in from the phone page starts the glasses app", async () => {
        sim.phone.open();
        const phase = sim.phone.waitFor<{ phase: string }>("turma:phase", (p) => p.phase === "running", 8000);
        await sim.phone.request("turma:storage-set", { key: CONFIG_STORAGE_KEY, value: JSON.stringify(config) });
        const res = await sim.phone.request<{ phase: string }>("turma:config-changed", {});
        check(res.phase === "running", "the background reports the running phase");
        await phase;
        await poll();
        const s = screen(sim);
        check(s.includes("TURMA"), "the home header is on the lens");
        check(hub.calls.length >= 0 && s.includes("truenas"), "the fleet's host is listed");
      }))
    )
      return;

    // ---------------------------------------------------------------- 3
    if (
      !(await step("The home screen lists hosts, sessions and the two standing rows", async () => {
        const s = screen(sim);
        check(/TURMA 0 run · 0 ask/.test(s), "the header counts working and waiting sessions");
        check(s.includes("- Turma-Fixing the lens"), "the session row is glyph + repo + name");
        check(s.includes("wsl-desktop offline"), "an offline host is shown as such");
        check(s.includes("+ New session"), "the new-session row is present");
        check(s.includes("Settings"), "the settings row is present");
        check(/> - Turma/.test(s), "the cursor starts on the first selectable row, not the host header");
      }))
    )
      return;

    // ---------------------------------------------------------------- 4
    if (
      !(await step("Swipes move the cursor and skip unselectable rows", async () => {
        sim.swipeDown();
        await sim.settle();
        check(/> \+ New session/.test(screen(sim)), "swipe down skips the offline host row");
        sim.swipeUp();
        await sim.settle();
        check(/> - Turma/.test(screen(sim)), "swipe up returns to the session row");
      }))
    )
      return;

    // ---------------------------------------------------------------- 5
    if (
      !(await step("Tapping a session opens it, with a live tail attached", async () => {
        sim.tap();
        await sim.settle();
        const s = screen(sim);
        check(s.includes("» Walk the miniapp"), "the user's turn renders with the » marker");
        check(s.includes("· On it"), "the agent's turn renders with the · marker");
        check(s.includes("Idle"), "the box's status corner shows the live state");
        await sim.waitFor(() => hub.liveWatchers().length > 0, 5000, "no /live socket opened");
        const watch = hub.liveWatchers()[0];
        check(watch?.host === "truenas" && watch?.id === "sess-1", "the live socket watches the focused session");
        const enter = sim.phone.last<{ sessionId: string }>("turma:enter-session");
        check(enter?.sessionId === "sess-1", "the phone is told which session the glasses entered");
      }))
    )
      return;

    // ---------------------------------------------------------------- 6
    if (
      !(await step("An in-progress turn streams onto the lens, then commits", async () => {
        hub.pushTurn("Reading the render module to see what the box does");
        await delay(1200);
        await sim.settle();
        check(screen(sim).includes("Reading the render module"), "the live turn types in as the agent speaks");
        hub.pushTail([{ id: "e3", role: "assistant", text: "Reading the render module to see what the box does" }]);
        hub.pushTurn("");
        // The committed entry and the still-live turn briefly coexist; the
        // turn's completion frame is what retires it. Wait for that rather than
        // for the render to go quiet, which can sample inside the 120ms
        // display debounce.
        await sim.waitFor(
          () => !/Reading the render module[\s\S]*Reading the render module/.test(screen(sim)),
          5000,
          "the live turn was never retired by its committed copy"
        );
        const s = screen(sim);
        check(s.includes("· Reading the render module"), "the committed turn replaces the live one");
        check(!/Reading the render module[\s\S]*Reading the render module/.test(s), "it is not shown twice");
      }))
    )
      return;

    // ---------------------------------------------------------------- 7
    if (
      !(await step("A working session reads as working, on the box and the home list", async () => {
        hub.session("sess-1")!.session!.paneBusy = true;
        await poll();
        check(screen(sim).includes("Working"), "the status corner flips to Working");
        sim.doubleTap();
        await sim.settle();
        const s = screen(sim);
        check(/TURMA 1 run · 0 ask/.test(s), "the home header counts it as running");
        check(s.includes("! Turma"), "its glyph is the working bang");
        sim.tap();
        await sim.settle();
      }))
    )
      return;

    // ---------------------------------------------------------------- 8
    if (
      !(await step("Scrolling past the top of the transcript fetches earlier history", async () => {
        hub.historyPending = 1;
        hub.historyEntries = [
          { id: "h1", role: "user", text: "Earlier: set the miniapp up" },
          { id: "h2", role: "assistant", text: "Earlier: done, it builds and packs" },
        ];
        sim.swipeUp();
        await delay(150);
        check(screen(sim).includes("loading earlier"), "the loading marker appears while the fetch is pending");
        await sim.waitFor(() => screen(sim).includes("Earlier: set the miniapp up"), 8000, "history never arrived");
        const s = screen(sim);
        check(s.includes("Earlier: set the miniapp up"), "the fetched history is prepended");
        check(!s.includes("loading earlier"), "the loading marker clears when it lands");
        // Back to the tail.
        for (let i = 0; i < 8; i++) sim.swipeDown();
        await sim.settle();
      }))
    )
      return;

    // ---------------------------------------------------------------- 9
    if (
      !(await step("A pending question takes over the box as an answer sheet", async () => {
        const live = hub.session("sess-1")!.session!;
        live.question = "Which base branch should I cut from?";
        live.questionOptions = ["origin/main", "origin/develop"];
        live.paneBusy = false;
        await poll();
        const s = screen(sim);
        check(s.includes("Which base branch"), "the question fills the box");
        check(s.includes("1. origin/main") && s.includes("2. origin/develop"), "the options are numbered");
        check(s.includes("3. Dictate answer…"), "a free-text row trails the options");
        check(/> 1\. origin\/main/.test(s), "the first option starts selected");
        sim.swipeDown();
        await sim.settle();
        check(/> 2\. origin\/develop/.test(screen(sim)), "swiping moves the highlight");
      }))
    )
      return;

    // ---------------------------------------------------------------- 10
    if (
      !(await step("Tapping an option answers the question", async () => {
        sim.tap();
        await delay(400);
        const call = hub.callsTo("/sessions/sess-1/answer").pop();
        check(!!call, "the answer reaches POST …/answer");
        check((call?.body as { optionIndex?: number })?.optionIndex === 1, "it carries the 0-based option index");
        check(screen(sim).includes("queued"), "the lens flashes that the answer was queued");
        const live = hub.session("sess-1")!.session!;
        live.question = null;
        live.questionOptions = [];
        await poll();
      }))
    )
      return;

    // ---------------------------------------------------------------- 11
    if (
      !(await step("Dictation into the box: tap to record, tap to finish", async () => {
        hub.transcript = "please rebase onto origin main and push";
        // Focus the box (tap at the tail hands focus to the bottom), then record.
        sim.tap();
        await sim.settle();
        check(screen(sim).includes("Tap to dictate"), "the focused empty box invites dictation");
        sim.tap();
        await delay(600);
        check(screen(sim).includes("Listening"), "the box shows it is recording");
        check(screen(sim).includes("[REC]"), "the status corner shows the mic is hot");
        check(sim.speak({ ms: 120 }), "the mic is subscribed, so frames are delivered");
        sim.speak({ ms: 120 });
        await delay(100);
        sim.tap();
        await sim.waitFor(() => screen(sim).includes("please rebase"), 8000, "the transcript never landed in the box");
        check(screen(sim).includes("please rebase onto origin main"), "the dictated text becomes the draft");
      }))
    )
      return;

    // ---------------------------------------------------------------- 12
    if (
      !(await step("With a draft in the box, the actions menu offers Send / Clear / Dictate more", async () => {
        sim.doubleTap();
        await sim.settle();
        const s = screen(sim);
        check(s.includes("Options"), "the menu is titled");
        check(s.includes("Back") && s.includes("Send") && s.includes("Clear"), "the draft actions are offered");
        check(s.includes("Dictate more"), "another dictation can be appended");
        check(!s.includes("Delete"), "the glasses never offer to delete a worktree");
        check(/> Back/.test(s), "the safe row is preselected");
        // Five rows into a four-row box: the last one is a scroll away, not gone.
        check(await moveTo(sim, "End this session"), "ending the session is reachable by scrolling");
        for (let i = 0; i < 5; i++) {
          if (onRow(sim, "Back")) break;
          sim.swipeUp();
          await sim.settle();
        }
      }))
    )
      return;

    // ---------------------------------------------------------------- 13
    if (
      !(await step("Send posts the draft to the session", async () => {
        sim.swipeDown();
        await sim.settle();
        check(/> Send/.test(screen(sim)), "the cursor is on Send");
        sim.tap();
        await delay(400);
        const call = hub.callsTo("/sessions/sess-1/input").pop();
        check(!!call, "the draft reaches POST …/input");
        check(
          (call?.body as { text?: string })?.text === "please rebase onto origin main and push",
          "the text is sent verbatim"
        );
        await sim.settle();
        check(!screen(sim).includes("please rebase"), "the box is emptied after sending");
      }))
    )
      return;

    // ---------------------------------------------------------------- 14
    if (
      !(await step("Ending a session asks first, and Cancel means cancel", async () => {
        sim.doubleTap(); // transcript focus -> home; re-enter and open the menu
        await sim.settle();
        sim.tap();
        await sim.settle();
        sim.tap(); // focus the box
        sim.doubleTap(); // actions
        await sim.settle();
        check(await moveTo(sim, "End this session"), "End this session is reachable");
        sim.tap();
        await sim.settle();
        const s = screen(sim);
        check(s.includes("End session"), "a confirmation names the session");
        check(/> Cancel/.test(s), "Cancel is preselected");
        const before = hub.callsTo("/sessions/sess-1/kill").length;
        sim.tap();
        await delay(300);
        check(hub.callsTo("/sessions/sess-1/kill").length === before, "cancelling kills nothing");
        check(screen(sim).includes("Options"), "cancelling returns to the actions menu");
      }))
    )
      return;

    // ---------------------------------------------------------------- 15
    if (
      !(await step("Confirming ends the session", async () => {
        check(await moveTo(sim, "End this session"), "back on End this session");
        sim.tap();
        await sim.settle();
        check(await moveTo(sim, "Confirm"), "Confirm is reachable");
        sim.tap();
        await delay(400);
        check(hub.callsTo("/sessions/sess-1/kill").length === 1, "the kill reaches POST …/kill");
        check(screen(sim).includes("queued"), "the lens confirms it was queued");
      }))
    )
      return;

    // ---------------------------------------------------------------- 16
    if (
      !(await step("A queued session reads as queued rather than idle", async () => {
        hub.agents[0]!.sessions.push(
          runningSession({
            id: "sess-2",
            repo: "DockerOps",
            summary: "Waiting for a slot",
            status: "queued",
            queuedReason: "capacity",
            createdAt: "2026-08-08T10:00:00Z",
            session: null,
          })
        );
        sim.doubleTap();
        await poll();
        check(screen(sim).includes("… DockerOps-Waiting for a slot"), "a queued session gets the pending glyph");
      }))
    )
      return;

    // ---------------------------------------------------------------- 17
    if (
      !(await step("A PR the session opened is surfaced in the transcript", async () => {
        hub.session("sess-1")!.session!.newPrUrls = ["https://github.com/xerktech/Turma/pull/406"];
        await poll();
        // Enter sess-1 (cursor is on the first session row).
        sim.tap();
        await sim.settle();
        check(screen(sim).includes("pull/406"), "the PR link renders at the newest end");
        sim.doubleTap();
        await sim.settle();
      }))
    )
      return;

    // ---------------------------------------------------------------- 18
    if (
      !(await step("Starting a new session: host, then repo, then prompt", async () => {
        await calm(sim); // the pickers' headers are what this step reads
        check(await moveTo(sim, "+ New session"), "the new-session row is reachable");
        sim.tap();
        await sim.settle();
        let s = screen(sim);
        check(s.includes("Choose host"), "the host picker opens");
        check(s.includes("truenas"), "an online host is offered");
        check(!s.includes("wsl-desktop"), "an offline host is not offered");
        sim.tap();
        await sim.settle();
        s = screen(sim);
        check(s.includes("Choose repo"), "the repo picker opens");
        check(s.includes("Repos root (all repos)"), "the repos-root pseudo-repo is labelled legibly");
        check(s.includes("Turma") && s.includes("DockerOps"), "the host's repos are offered");
        check(await moveTo(sim, "Turma"), "a repo can be selected");
        sim.tap();
        await sim.settle();
        s = screen(sim);
        check(s.includes("Dictate initial prompt"), "the prompt step offers dictation");
        check(s.includes("Skip (spawn now)"), "and a bare spawn");
      }))
    )
      return;

    // ---------------------------------------------------------------- 19
    if (
      !(await step("Skip spawns the session bare", async () => {
        check(await moveTo(sim, "Skip (spawn now)"), "Skip is selectable");
        sim.tap();
        await delay(400);
        const call = hub.callsTo("/truenas/sessions").pop();
        check(!!call, "the spawn reaches POST …/sessions");
        check((call?.body as { repo?: string })?.repo === "Turma", "it names the chosen repo");
        check((call?.body as { prompt?: string })?.prompt === undefined, "a bare spawn carries no prompt");
        await calm(sim);
        check(screen(sim).includes("TURMA"), "the app returns home");
      }))
    )
      return;

    // ---------------------------------------------------------------- 20
    if (
      !(await step("A dictated initial prompt is previewed before it spawns", async () => {
        hub.transcript = "port the phone tour to the simulator";
        await calm(sim);
        check(await moveTo(sim, "+ New session"), "back at the new-session row");
        sim.tap();
        await sim.settle();
        sim.tap(); // the only online host
        await sim.settle();
        await moveTo(sim, "Turma");
        sim.tap(); // repo
        await sim.settle();
        check(onRow(sim, "Dictate initial prompt…"), "the dictate row is preselected");
        sim.tap();
        await delay(600);
        check(screen(sim).includes("listening"), "the reply screen listens");
        sim.speak({ ms: 120 });
        await delay(100);
        sim.tap();
        await sim.waitFor(() => screen(sim).includes("port the phone tour"), 8000, "the preview never appeared");
        const s = screen(sim);
        check(s.includes("chars"), "the preview counts the characters");
        check(s.includes("Send") && s.includes("Redo") && s.includes("Cancel"), "Send / Redo / Cancel are offered");
        sim.tap();
        await delay(400);
        const call = hub.callsTo("/truenas/sessions").pop();
        check(
          (call?.body as { prompt?: string })?.prompt === "port the phone tour to the simulator",
          "the dictated prompt spawns with the session"
        );
      }))
    )
      return;

    // ---------------------------------------------------------------- 21
    if (
      !(await step("Settings reports the fleet and points configuration at the phone", async () => {
        check(await moveTo(sim, "Settings"), "the settings row is reachable");
        await calm(sim);
        sim.tap();
        await sim.settle();
        const s = screen(sim);
        check(s.includes("Settings"), "the settings screen opens");
        check(s.includes("1/2 hosts online"), "it counts online hosts");
        check(s.includes("Configure on phone"), "it points at the phone for credentials");
        sim.tap();
        await sim.settle();
        check(screen(sim).includes("run ·"), "any tap returns home");
      }))
    )
      return;

    // ---------------------------------------------------------------- 22
    if (
      !(await step("An unreachable hub says so, and recovers silently", async () => {
        hub.down = true;
        await sim.waitFor(() => screen(sim).includes("hub unreachable"), 8000, "no unreachable flash");
        check(screen(sim).includes("hub unreachable"), "the lens says the hub is unreachable");
        hub.down = false;
        await delay(1500);
        await sim.settle();
        check(!screen(sim).includes("hub unreachable"), "the warning clears once polling recovers");
      }))
    )
      return;

    // ---------------------------------------------------------------- 23
    if (
      !(await step("Backgrounding stops the poll and the live tail; foregrounding resumes", async () => {
        // Enter a session first so there is a live socket to stop.
        for (let i = 0; i < 8; i++) {
          if (/> [!\-?…] Turma/.test(screen(sim))) break;
          sim.swipeUp();
          await sim.settle();
        }
        sim.tap();
        await sim.settle();
        await sim.waitFor(() => hub.liveWatchers().length > 0, 5000, "no live socket before backgrounding");
        sim.background();
        await sim.waitFor(() => hub.liveWatchers().length === 0, 5000, "the live socket outlived backgrounding");
        check(hub.liveWatchers().length === 0, "backgrounding closes the live tail");
        const before = hub.calls.length;
        await delay(1500);
        // The post-mutation grace window may still be open, but nothing was
        // mutated recently here, so the loop should be quiet.
        check(hub.calls.length === before, "backgrounding stops mutating traffic");
        sim.foreground();
        await sim.waitFor(() => hub.liveWatchers().length > 0, 6000, "the live tail never came back");
        check(hub.liveWatchers().length > 0, "foregrounding re-attaches the live tail");
      }))
    )
      return;

    // ---------------------------------------------------------------- 24
    if (
      !(await step("A question outranks working, and a long option list windows", async () => {
        const live = hub.session("sess-1")!.session!;
        live.paneBusy = true;
        live.question = "The base branch has moved on. How should I bring the branch up to date before I push?";
        live.questionOptions = ["Merge origin/main", "Rebase onto origin/main", "Leave it and flag the conflict", "Ask the reviewer"];
        await poll();
        sim.doubleTap(); // home, to read the header
        await sim.settle();
        check(/TURMA 0 run · 1 ask/.test(screen(sim)), "a pending question outranks the working signal in the header");
        check(screen(sim).includes("? Turma"), "and the row glyph asks for attention");
        sim.tap(); // back into the session
        await sim.settle();
        const s = screen(sim);
        check(s.includes("The base branch has moved on"), "the question wraps into the sheet");
        check(/> 1\. Merge origin\/main/.test(s), "the first option is selected");
        check(!s.includes("5. Dictate answer"), "the overflowing rows are windowed out, not crammed in");
        await moveTo(sim, "5. Dictate answer…");
        check(onRow(sim, "5. Dictate answer…"), "scrolling reaches the free-text row");
        check(screen(sim).includes("4. Ask the reviewer"), "the window slid with the cursor");
      }))
    )
      return;

    // ---------------------------------------------------------------- 25
    if (
      !(await step("Dictation that fails says why and leaves the mic idle", async () => {
        hub.transcriptUnavailable = "no speech detected";
        check(await moveTo(sim, "5. Dictate answer…"), "the sheet's free-text row is selected");
        sim.tap(); // the "Dictate answer…" row starts box dictation
        await delay(600);
        check(screen(sim).includes("Listening"), "the mic went hot from the sheet");
        sim.speak({ ms: 80 });
        sim.tap();
        await sim.waitFor(() => screen(sim).includes("no speech detected"), 8000, "the failure was never surfaced");
        check(screen(sim).includes("no speech detected"), "the reason is flashed to the operator");
        await sim.settle();
        check(!screen(sim).includes("Listening"), "the box is not stuck recording");
        hub.transcriptUnavailable = null;
      }))
    )
      return;

    // ---------------------------------------------------------------- 26
    if (
      !(await step("A dictated free-text reply answers the pending question", async () => {
        hub.transcript = "merge it, and mention the conflict in the PR";
        const answersBefore = hub.callsTo("/sessions/sess-1/answer").length;
        const inputsBefore = hub.callsTo("/sessions/sess-1/input").length;
        await sim.waitFor(() => !screen(sim).includes("no speech"), 8000, "the flash never expired");
        check(await moveTo(sim, "5. Dictate answer…"), "the sheet's free-text row is selected");
        sim.tap(); // the dictate row -> record
        await delay(600);
        sim.speak({ ms: 100 });
        sim.tap();
        await sim.waitFor(() => screen(sim).includes("merge it, and mention"), 8000, "no draft landed");
        sim.doubleTap();
        await sim.settle();
        check(await moveTo(sim, "Send"), "Send is offered for the dictated answer");
        sim.tap();
        await delay(400);
        const call = hub.callsTo("/sessions/sess-1/answer").pop();
        check(
          hub.callsTo("/sessions/sess-1/answer").length === answersBefore + 1 &&
            hub.callsTo("/sessions/sess-1/input").length === inputsBefore,
          "a free-text answer rides …/answer, not …/input"
        );
        const body = call?.body as { optionIndex?: number; custom?: string };
        check(body?.optionIndex === -1, "it marks itself as free text");
        check(body?.custom === "merge it, and mention the conflict in the PR", "and carries the dictated words");
        const live = hub.session("sess-1")!.session!;
        live.question = null;
        live.questionOptions = [];
        live.paneBusy = false;
        await poll();
      }))
    )
      return;

    // ---------------------------------------------------------------- 27
    if (
      !(await step("A long turn wraps to the lens rather than running off it", async () => {
        hub.pushTail([
          {
            id: "e9",
            role: "assistant",
            text:
              "I walked every screen: the home list, the session transcript, the answer sheet, " +
              "the actions menu and the spawn flow, and each one rendered inside the 576 by 288 canvas.",
          },
        ]);
        await sim.settle();
        const lens = sim.lens();
        const tooWide = lens
          .split("\n")
          .filter((l) => l.startsWith("|"))
          .some((l) => l.length > 100);
        check(!tooWide, "no rendered line overflows the canvas width");
        check(screen(sim).includes("I walked every screen"), "the turn is on screen");
        // The phone's own scene wrapper trims every line it lays out
        // (TextWrapper's `trimLines`, which a miniapp cannot opt out of), so a
        // leading indent never survives to the glass — the role markers are
        // what separate turns. render.ts must not reserve width for one.
        check(!/\n {2}\S/.test(screen(sim)), "continuation lines render flush, as the phone's wrapper forces");
      }))
    )
      return;

    // ---------------------------------------------------------------- 28
    if (
      !(await step("A stopped session offers Start instead of the draft actions", async () => {
        const s1 = hub.session("sess-1")!;
        s1.status = "stopped";
        s1.session = null;
        await poll();
        check(screen(sim).includes("Stopped"), "the box reports the session is stopped");
        sim.tap(); // focus the box
        sim.doubleTap(); // actions
        await sim.settle();
        const menu = screen(sim);
        check(menu.includes("Start"), "Start is offered");
        check(!menu.includes("End this session"), "ending an already-stopped session is not offered");
        check(await moveTo(sim, "Start"), "Start is selectable");
        sim.tap();
        await delay(400);
        check(hub.callsTo("/sessions/sess-1/start").length === 1, "it reaches POST …/start");
        s1.status = "running";
        s1.session = runningSession().session;
        await poll();
      }))
    )
      return;

    // ---------------------------------------------------------------- 29
    if (
      !(await step("A session that leaves the fleet doesn't strand the screen", async () => {
        const agent = hub.agents[0]!;
        const removed = agent.sessions.find((s) => s.id === "sess-1")!;
        agent.sessions = agent.sessions.filter((s) => s.id !== "sess-1");
        await poll(3);
        const s = screen(sim);
        check(!s.includes("Tap to dictate"), "the box does not invite input on a session that is gone");
        check(
          s.includes("run ·") || s.includes("gone") || s.includes("ended"),
          "the operator is not left staring at a dead transcript"
        );
        agent.sessions.unshift(removed);
        await poll(2);
      }))
    )
      return;

    // ---------------------------------------------------------------- 30
    if (
      !(await step("The phone can pull the glasses into a session and scope the list", async () => {
        sim.doubleTap();
        await sim.settle();
        await sim.phone.request("turma:cmd", { kind: "enterSession", sessionId: "sess-2", hostKey: "truenas" });
        await sim.settle();
        check(screen(sim).includes("Waiting for a slot") || screen(sim).includes("Queued"), "the glasses follow the phone into the session");
        sim.doubleTap();
        await sim.settle();
        await sim.phone.request("turma:cmd", { kind: "setOrgFilter", siteKey: "other.atlassian.net" });
        await poll();
        check(!screen(sim).includes("truenas"), "an org filter with no hosts empties the list");
        check(screen(sim).includes("+ New session"), "the standing rows survive the filter");
        await sim.phone.request("turma:cmd", { kind: "setOrgFilter", siteKey: "" });
        await poll();
        check(screen(sim).includes("truenas"), "clearing the filter restores the fleet");
      }))
    )
      return;

    // ---------------------------------------------------------------- 25
    if (
      !(await step("The phone gets a state snapshot, whole and in chunks", async () => {
        const snap = await sim.phone.request<{ phase: string; state: unknown }>("turma:get-state", {});
        check(snap.phase === "running", "get-state reports the running phase");
        check(!!snap.state, "and carries a state payload");
        const first = await sim.phone.request<{ total: number; seq: number; chunk: string; v: number }>(
          "turma:state-chunk",
          { seq: 0 }
        );
        check(first.total >= 1, "the chunked pull reports how many slices it has");
        let assembled = first.chunk;
        for (let seq = 1; seq < first.total; seq++) {
          const part = await sim.phone.request<{ chunk: string }>("turma:state-chunk", { seq });
          assembled += part.chunk;
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(assembled);
        } catch {
          /* reported below */
        }
        check(!!parsed, "the reassembled chunks parse as the state payload");
      }))
    )
      return;

    // ---------------------------------------------------------------- 26
    if (
      !(await step("Signing out returns the glasses to the setup screen", async () => {
        await sim.phone.request("turma:storage-set", { key: CONFIG_STORAGE_KEY, value: "" });
        const res = await sim.phone.request<{ phase: string }>("turma:config-changed", {});
        check(res.phase === "setup", "the background drops back to setup");
        await sim.settle();
        check(screen(sim).includes("Set up on your phone"), "the lens shows the setup screen again");
        const before = hub.calls.length;
        await delay(1200);
        check(hub.calls.length === before, "a signed-out app stops talking to the hub");
      }))
    )
      return;

    // ---------------------------------------------------------------- 27
    await step("The miniapp asks the host for nothing the phone can't do", async () => {
      check(
        sim.host.unimplemented.length === 0,
        `no unimplemented host calls (saw: ${sim.host.unimplemented.join(", ") || "none"})`
      );
      const stored = sim.host.storageSnapshot();
      check(CONFIG_STORAGE_KEY in stored, "the config lives under the documented storage key");
    });
  } finally {
    await sim.stop().catch(() => {});
    await hub.stop();
  }

  console.log("");
  if (findings.length) {
    console.log(`${findings.length} finding${findings.length === 1 ? "" : "s"}:`);
    for (const f of findings) console.log(`  • ${f}`);
  } else {
    console.log("No findings — every step behaved.");
  }
  // Exit on the verdict rather than waiting for the loop to drain: a dictation
  // leaves a socket the emulated JSContext owned, and nothing here needs to
  // outlive the report.
  process.exit(findings.length ? 1 : 0);
}

await main();
