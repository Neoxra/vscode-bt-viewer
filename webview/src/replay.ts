/**
 * @fileoverview .btlog replay playback. Drives the same status overlay path
 * as the live monitor, but the clock lives here: transitions are folded up to
 * the playhead into a {uid -> status} snapshot on every frame/seek. All replay
 * state is private to this module's setup function, which wires its own
 * listeners; other module code only ever asks replayActive(), which reads the
 * DOM.
 */

import { ReplayTransition, StatusMap, TreeData, ViewerContext } from "./context";
import { fitToView } from "./interaction";
import { autoCollapseDepth, countVisibleNodes } from "./layout";
import { readThemeColors } from "./constants";
import {
  applyMonitorStatus,
  clearMonitorOverlay,
  updateFollowButtonState,
} from "./monitor";
import { render } from "./render";
import { showBlackboard, showPalette } from "./sidePanels";
import { populateTreeSelector } from "./toolbar";

interface LoadReplayMessage {
  command: "loadReplay";
  data: TreeData;
  fileName?: string;
  transitions?: ReplayTransition[];
  duration?: number;
  recordedAtMs?: number;
}

export function setUpReplayPlayback(ctx: ViewerContext): void {
  const replay = {
    mode: false,
    transitions: [] as ReplayTransition[], // [{ t: seconds, uid, status }], time-sorted
    duration: 0,        // seconds
    snapshot: {} as StatusMap, // uid(string) -> status, folded up to snapshotTime
    cursor: 0,          // next transitions index to fold into the snapshot
    snapshotTime: 0,    // time the snapshot currently reflects
    playheadTime: 0,
    playing: false,
    speed: 1,           // playback multiplier; 1 = real time
    frameRequest: null as number | null, // requestAnimationFrame handle while playing
    previousFrame: 0,   // performance.now() of the previous animation frame
    bar: null as HTMLDivElement | null,  // transport bar element, built lazily
    playButton: null as HTMLButtonElement | null,
    scrubber: null as HTMLInputElement | null,
    timeLabel: null as HTMLSpanElement | null,
  };

  function formatTime(seconds: number): string {
    return `${(seconds > 0 ? seconds : 0).toFixed(2)}s`;
  }

  // Build the transport bar once and cache the control refs. Created via the
  // DOM API (no inline HTML) so it stays within the webview's strict CSP.
  function buildTransportBar(): void {
    if (replay.bar) return;
    const bar = document.createElement("div");
    bar.id = "replay-bar";
    bar.className = "hidden";

    const label = document.createElement("span");
    label.className = "toolbar-hint replay-label";
    label.textContent = "Replay";

    replay.playButton = document.createElement("button");
    replay.playButton.id = "replay-play";
    replay.playButton.className = "toolbar-btn";
    replay.playButton.title = "Play / Pause (Space)";
    replay.playButton.textContent = "▶";
    replay.playButton.addEventListener("click", () => setPlaying(!replay.playing));

    replay.scrubber = document.createElement("input");
    replay.scrubber.id = "replay-scrubber";
    replay.scrubber.type = "range";
    replay.scrubber.min = "0";
    replay.scrubber.max = "1";
    replay.scrubber.step = "any";
    replay.scrubber.value = "0";
    replay.scrubber.addEventListener("input", () => seekTo(parseFloat(replay.scrubber!.value) || 0));
    // Keep module keyboard shortcuts from firing while the slider has
    // focus; the slider handles arrow keys natively.
    replay.scrubber.addEventListener("keydown", (e) => e.stopPropagation());

    replay.timeLabel = document.createElement("span");
    replay.timeLabel.id = "replay-time";
    replay.timeLabel.className = "toolbar-hint";

    const speedSelect = document.createElement("select");
    speedSelect.id = "replay-speed";
    speedSelect.className = "toolbar-select";
    speedSelect.title = "Playback speed";
    for (const multiplier of [0.25, 0.5, 1, 2, 4, 8]) {
      const option = document.createElement("option");
      option.value = String(multiplier);
      option.textContent = `${multiplier}x`;
      if (multiplier === replay.speed) option.selected = true;
      speedSelect.appendChild(option);
    }
    speedSelect.addEventListener("change", () => {
      replay.speed = parseFloat(speedSelect.value) || 1;
      replay.previousFrame = performance.now();
    });
    speedSelect.addEventListener("keydown", (e) => e.stopPropagation());

    bar.append(label, replay.playButton, replay.scrubber, replay.timeLabel, speedSelect);

    const toolbar = document.getElementById("toolbar");
    if (toolbar) toolbar.insertAdjacentElement("afterend", bar);
    replay.bar = bar;
  }

  /** Materialise the {uid -> status} snapshot at `seconds` and paint it. */
  function seekTo(seconds: number): void {
    const clamped = Math.min(Math.max(seconds, 0), replay.duration);
    replay.playheadTime = clamped;
    // Backward seek: rewind the fold and rebuild from the start.
    if (clamped < replay.snapshotTime) {
      replay.snapshot = {};
      replay.cursor = 0;
    }
    while (replay.cursor < replay.transitions.length && replay.transitions[replay.cursor].t <= clamped) {
      const transition = replay.transitions[replay.cursor++];
      replay.snapshot[String(transition.uid)] = transition.status;
    }
    replay.snapshotTime = clamped;
    // Fresh object each call: applyMonitorStatus stores the reference.
    applyMonitorStatus(ctx, { ...replay.snapshot });
    updateTransportBar();
  }

  function updateTransportBar(): void {
    if (!replay.bar) return;
    replay.scrubber!.value = String(replay.playheadTime);
    replay.timeLabel!.textContent = `${formatTime(replay.playheadTime)} / ${formatTime(replay.duration)}`;
  }

  function advancePlayhead(now: number): void {
    replay.frameRequest = null;
    if (!replay.mode || !replay.playing) return;
    const elapsedSeconds = (now - replay.previousFrame) / 1000;
    replay.previousFrame = now;
    const next = replay.playheadTime + elapsedSeconds * replay.speed;
    if (next >= replay.duration) {
      seekTo(replay.duration);
      setPlaying(false);
      return;
    }
    seekTo(next);
    replay.frameRequest = requestAnimationFrame(advancePlayhead);
  }

  function setPlaying(playing: boolean): void {
    if (playing && replay.duration <= 0) return;
    replay.playing = playing;
    if (replay.playButton) replay.playButton.textContent = playing ? "⏸" : "▶";
    if (playing) {
      // Restart from the beginning if the playhead is parked at the end.
      if (replay.playheadTime >= replay.duration) seekTo(0);
      replay.previousFrame = performance.now();
      if (!replay.frameRequest) replay.frameRequest = requestAnimationFrame(advancePlayhead);
    } else if (replay.frameRequest) {
      cancelAnimationFrame(replay.frameRequest);
      replay.frameRequest = null;
    }
  }

  /** Pause, then jump to the nearest transition before/after the playhead. */
  function stepToTransition(direction: number): void {
    if (!replay.transitions.length) return;
    setPlaying(false);
    let target: number;
    if (direction > 0) {
      target = replay.duration;
      for (const transition of replay.transitions) {
        if (transition.t > replay.playheadTime) { target = transition.t; break; }
      }
    } else {
      target = 0;
      for (const transition of replay.transitions) {
        if (transition.t < replay.playheadTime) target = transition.t; else break;
      }
    }
    seekTo(target);
  }

  function enterReplay(msg: LoadReplayMessage): void {
    // Load the embedded tree exactly like updateTree does.
    ctx.treeData = msg.data;
    ctx.colors = readThemeColors();
    ctx.fileNameEl.textContent = msg.fileName || "BT Replay";
    ctx.errorOverlay.classList.add("hidden");
    ctx.collapsedNodes.clear();
    ctx.selectedTreeId = null;
    populateTreeSelector(ctx);
    if (ctx.treeData && ctx.treeData.trees) {
      const tree = ctx.treeData.trees.find((t) => t.id === ctx.treeData!.mainTreeId) || ctx.treeData.trees[0];
      if (tree && tree.root && countVisibleNodes(ctx, tree.root) > 30) {
        autoCollapseDepth(ctx, tree.root, 0, ctx.autoCollapseLevel);
      }
    }
    render(ctx);
    setTimeout(() => fitToView(ctx), 150);
    if (ctx.activeSidePanel === "blackboard") showBlackboard(ctx);
    if (ctx.activeSidePanel === "palette") showPalette(ctx);

    // Replay and the live monitor are mutually exclusive.
    if (ctx.monitorActive) {
      ctx.vscode.postMessage({ command: "stopMonitor" });
      ctx.monitorActive = false;
      ctx.btnMonitor.classList.remove("active");
    }
    ctx.btnMonitor.classList.add("hidden");
    clearMonitorOverlay(ctx);

    replay.mode = true;
    replay.transitions = Array.isArray(msg.transitions) ? msg.transitions : [];
    replay.duration = typeof msg.duration === "number" ? msg.duration : 0;
    replay.snapshot = {};
    replay.cursor = 0;
    replay.snapshotTime = 0;
    replay.playheadTime = 0;
    setPlaying(false);

    buildTransportBar();
    replay.scrubber!.max = String(replay.duration || 1);
    replay.bar!.classList.remove("hidden");
    ctx.monitorStatusEl.textContent = "";
    updateFollowButtonState(ctx);
    seekTo(0);
  }

  function exitReplay(): void {
    if (!replay.mode) return;
    setPlaying(false);
    replay.mode = false;
    replay.transitions = [];
    replay.duration = 0;
    replay.snapshot = {};
    replay.cursor = 0;
    replay.snapshotTime = 0;
    replay.playheadTime = 0;
    if (replay.bar) replay.bar.classList.add("hidden");
    ctx.btnMonitor.classList.remove("hidden");
    clearMonitorOverlay(ctx);
    updateFollowButtonState(ctx);
  }

  // A recording opens replay; opening any other tree closes it. Self-wired
  // so the module's message handler never needs to know replay exists.
  function handleHostMessage(event: MessageEvent): void {
    const msg = event.data;
    if (msg.command === "loadReplay") enterReplay(msg as LoadReplayMessage);
    else if (msg.command === "updateTree" && replay.mode) exitReplay();
  }

  // Transport keys, ignored while typing in an input/select.
  function handleTransportKeydown(e: KeyboardEvent): void {
    if (!replay.mode) return;
    const focused = document.activeElement;
    if (focused && (focused.tagName === "INPUT" || focused.tagName === "SELECT" || focused.tagName === "TEXTAREA")) return;
    if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); setPlaying(!replay.playing); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepToTransition(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); stepToTransition(-1); }
  }

  window.addEventListener("message", handleHostMessage);
  window.addEventListener("keydown", handleTransportKeydown);
}
