/**
 * @fileoverview Composition root for the BehaviorTree viewer webview. Builds
 * the shared context, wires every module's event listeners, and handles the
 * extension-host message channel. Renders BT.CPP v4 tree data as an
 * interactive SVG diagram; nodes are individually draggable and edges update
 * in real time.
 */

import { HostToWebviewMessage } from "../../shared/protocol";
import { readThemeColors } from "./constants";
import { createViewerContext, TreeData } from "./context";
import { fitToView, initPanZoom, updateTransform } from "./interaction";
import { autoCollapseDepth, countVisibleNodes } from "./layout";
import { initMinimap } from "./minimap";
import {
  applyMonitorStatus,
  clearMonitorOverlay,
  replayActive,
  updateFollowButtonState,
} from "./monitor";
import { render } from "./render";
import { initSidePanels, showBlackboard, showPalette } from "./sidePanels";
import { setUpReplayPlayback } from "./replay";
import { initToolbar, populateTreeSelector } from "./toolbar";

const ctx = createViewerContext(readThemeColors());

initPanZoom(ctx);
initMinimap(ctx);
initToolbar(ctx);
initSidePanels(ctx);
setUpReplayPlayback(ctx);

// Ctrl/Cmd hover hint: while the modifier is held, nodes get a hyperlink
// cursor and a focus-tinted outline so it's clear they're click-to-jump.
function setCtrlHeld(held: boolean): void {
  document.body.classList.toggle("ctrl-held", held);
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Control" || e.key === "Meta") setCtrlHeld(true);
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Control" || e.key === "Meta") setCtrlHeld(false);
});
window.addEventListener("blur", () => setCtrlHeld(false));

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") fitToView(ctx);
  if (e.key === "+" || e.key === "=") { ctx.camera.zoom = Math.min(5, ctx.camera.zoom * 1.2); updateTransform(ctx); }
  if (e.key === "-") { ctx.camera.zoom = Math.max(0.1, ctx.camera.zoom / 1.2); updateTransform(ctx); }
  if (e.key === "0") { ctx.camera.zoom = 1; updateTransform(ctx); }
  if (e.key === "r" || e.key === "R") { render(ctx); setTimeout(() => fitToView(ctx), 50); }
  // Ctrl+F to focus search
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    ctx.searchInput.focus();
  }
});

window.addEventListener("message", (event) => {
  const msg = event.data as HostToWebviewMessage;
  switch (msg.command) {
    case "updateTree":
      // loadReplay and replay-exit-on-updateTree are handled by the replay
      // module's own message listener (see setUpReplayPlayback).
      ctx.treeData = msg.data as TreeData;
      // Always re-read from CSS so colours track the live VSCode theme,
      // even if the host posted updateTree before the first themeChanged.
      ctx.colors = readThemeColors();
      ctx.fileNameEl.textContent = msg.fileName || "Behavior Tree";
      ctx.errorOverlay.classList.add("hidden");
      ctx.view.collapsedNodes.clear();
      ctx.view.selectedTreeId = null;
      populateTreeSelector(ctx);
      // Auto-collapse deep branches for large trees
      if (ctx.treeData && ctx.treeData.trees) {
        const treeId = ctx.view.selectedTreeId || ctx.treeData.mainTreeId;
        const tree = ctx.treeData.trees.find(t => t.id === treeId) || ctx.treeData.trees[0];
        if (tree && tree.root) {
          const total = countVisibleNodes(ctx, tree.root);
          if (total > 30) {
            autoCollapseDepth(ctx, tree.root, 0, ctx.view.autoCollapseLevel);
          }
        }
      }
      render(ctx);
      setTimeout(() => fitToView(ctx), 150);
      // Refresh side panel if open
      if (ctx.view.activeSidePanel === "blackboard") showBlackboard(ctx);
      if (ctx.view.activeSidePanel === "palette") showPalette(ctx);
      break;

    case "error":
      ctx.errorOverlay.classList.remove("hidden");
      ctx.errorMessage.textContent = msg.message;
      break;

    case "monitorStatus":
      applyMonitorStatus(ctx, msg.nodes || {});
      break;

    case "monitorInfo":
      ctx.monitorStatusEl.textContent = msg.message;
      break;

    case "monitorError":
      ctx.monitorStatusEl.textContent = msg.message;
      ctx.monitorStatusEl.style.color = "var(--vscode-errorForeground, #f44)";
      setTimeout(() => { ctx.monitorStatusEl.style.color = ""; }, 3000);
      break;

    case "monitorConnected":
      ctx.monitor.active = true;
      ctx.btnMonitor.classList.add("active");
      updateFollowButtonState(ctx);
      break;

    case "monitorStopped":
      ctx.monitor.active = false;
      ctx.btnMonitor.classList.remove("active");
      ctx.monitorStatusEl.textContent = "";
      // Entering replay stops the monitor; don't let that async ack wipe the
      // replay overlay we just painted.
      if (!replayActive()) clearMonitorOverlay(ctx);
      updateFollowButtonState(ctx);
      break;

    case "monitorAvailability":
      ctx.monitor.available = !!msg.available;
      if (ctx.monitor.available) {
        ctx.btnMonitor.classList.remove("disabled");
        ctx.btnMonitor.removeAttribute("aria-disabled");
        ctx.btnMonitor.title = "Live monitor via ZMQ (port 1666)";
      } else {
        ctx.btnMonitor.classList.add("disabled");
        ctx.btnMonitor.setAttribute("aria-disabled", "true");
        ctx.btnMonitor.title = msg.reason || "Live monitoring unavailable on this platform";
      }
      break;

    case "themeChanged":
      // VSCode swapped the active colour theme; pull the new chart values
      // and repaint everything that doesn't already cascade via CSS vars
      // (SVG fills/strokes set as attributes, minimap canvas).
      ctx.colors = readThemeColors();
      if (ctx.treeData) {
        render(ctx);
        // Side panel content embeds the chart hexes inline (border-left
        // styles, swatches), so refresh whichever is open.
        if (ctx.view.activeSidePanel === "blackboard") showBlackboard(ctx);
        if (ctx.view.activeSidePanel === "palette") showPalette(ctx);
      }
      break;
  }
});

// Re-layout and fit on window resize
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (ctx.treeData) {
      render(ctx);
      fitToView(ctx);
    }
  }, 100);
});
