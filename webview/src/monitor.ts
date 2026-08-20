/**
 * @fileoverview Status overlay shared by the live monitor and .btlog replay:
 * painting per-node status classes, follow-mode expansion and camera, the
 * idle fade, and clearing everything when a monitor or replay ends.
 */

import { StatusMap, ViewerContext } from "./context";
import { updateTransform } from "./interaction";
import { expandRunningPath } from "./layout";
import { drawMinimap } from "./minimap";
import { render } from "./render";

/**
 * Replay owns its state privately; the transport bar's visibility is the
 * single source of truth for "a replay is on screen", so other module code
 * reads the DOM rather than a shared variable.
 */
export function replayActive(): boolean {
  const bar = document.getElementById("replay-bar");
  return !!bar && !bar.classList.contains("hidden");
}

export function updateFollowButtonState(ctx: ViewerContext): void {
  if (!ctx.btnFollow) return;
  if (ctx.monitorActive || replayActive()) {
    ctx.btnFollow.classList.remove("hidden");
  } else {
    ctx.btnFollow.classList.add("hidden");
    ctx.followMode = false;
    ctx.btnFollow.classList.remove("active");
  }
}

/**
 * Paint the {uid -> status} overlay onto the current node elements: status
 * colour class plus the dashed `subtree-active` border for running SubTree
 * nodes. Used both on a normal status update and after a follow-mode render()
 * rebuilds the DOM, so the two paths can never drift apart.
 */
function applyStatusClasses(ctx: ViewerContext, statuses: StatusMap, runningUids: Set<string>): void {
  for (const node of ctx.layoutNodes) {
    const el = ctx.nodeElements.get(node.id);
    if (!el) continue;

    el.classList.remove("status-idle", "status-running", "status-success", "status-failure", "status-skipped", "subtree-active");

    if (node.uid !== undefined) {
      const status = statuses[String(node.uid)];
      if (status) {
        el.classList.add("status-" + status.toLowerCase());
      }
    }

    if (node.category === "subtree" && runningUids.size > 0) {
      const subtreeUid = node.uid;
      if (subtreeUid !== undefined && statuses[String(subtreeUid)] === "RUNNING") {
        el.classList.add("subtree-active");
      }
    }
  }
}

/**
 * Repaint the last-known status overlay onto freshly-rendered nodes. A manual
 * render() (Expand All / Reset / Depth / View) rebuilds the DOM and strips the
 * status classes; during a replay or live monitor that would blank the colours
 * until the next status tick, so re-apply them here. Paints colours only; it
 * does NOT move the camera, so it won't fight an explicit expand/collapse.
 */
export function reapplyStatusOverlay(ctx: ViewerContext): void {
  // A non-empty lastNodeStatuses means an overlay (replay or live monitor) is
  // active; that's the only case where a re-render needs the colours restored.
  if (!ctx.lastNodeStatuses || Object.keys(ctx.lastNodeStatuses).length === 0) return;
  const runningUids = new Set<string>();
  for (const [uid, st] of Object.entries(ctx.lastNodeStatuses)) {
    if (st === "RUNNING") runningUids.add(uid);
  }
  applyStatusClasses(ctx, ctx.lastNodeStatuses, runningUids);
}

export function applyMonitorStatus(ctx: ViewerContext, statuses: StatusMap): void {
  ctx.lastNodeStatuses = statuses;

  // Empty statuses = server disconnected (BT finished)
  if (Object.keys(statuses).length === 0) {
    fadeMonitorOverlay();
    return;
  }

  // Check if everything is idle
  const runningUids = new Set<string>();
  let allIdle = true;
  for (const [uid, status] of Object.entries(statuses)) {
    if (status === "RUNNING") runningUids.add(uid);
    if (status !== "IDLE") allIdle = false;
  }

  // If all nodes are idle, start a fade timer
  if (allIdle) {
    if (!ctx.idleFadeTimer) {
      ctx.idleFadeTimer = setTimeout(() => {
        fadeMonitorOverlay();
        ctx.idleFadeTimer = null;
      }, 1500); // Fade after 1.5s of continuous idle
    }
  } else {
    // Active nodes: cancel any pending fade
    if (ctx.idleFadeTimer) {
      clearTimeout(ctx.idleFadeTimer);
      ctx.idleFadeTimer = null;
    }
    // Remove fade class if it was applied
    const svgEl = document.getElementById("tree-group");
    if (svgEl) svgEl.classList.remove("monitor-faded");
  }

  applyStatusClasses(ctx, statuses, runningUids);

  drawMinimap(ctx);

  if (ctx.followMode) {
    // Auto-expand running path, collapse inactive deep branches
    if (ctx.treeData && ctx.treeData.trees) {
      const treeId = ctx.selectedTreeId || ctx.treeData.mainTreeId;
      const tree = ctx.treeData.trees.find(t => t.id === treeId) || ctx.treeData.trees[0];
      if (tree && tree.root) {
        const changed = { value: false };
        expandRunningPath(ctx, tree.root, statuses, changed);
        if (changed.value) {
          const savedPanX = ctx.panX;
          const savedPanY = ctx.panY;
          const savedZoom = ctx.zoom;
          render(ctx);
          ctx.panX = savedPanX;
          ctx.panY = savedPanY;
          ctx.zoom = savedZoom;
          // render() rebuilt the DOM and stripped every status class, so
          // re-apply the full overlay (status + subtree-active), not just
          // the status colours.
          applyStatusClasses(ctx, statuses, runningUids);
        }
      }
    }
    zoomToRunning(ctx, statuses);
  }
}

function fadeMonitorOverlay(): void {
  const svgEl = document.getElementById("tree-group");
  if (svgEl) svgEl.classList.add("monitor-faded");
}

/** Find the deepest (highest UID) running leaf node and pan/zoom to it. */
function zoomToRunning(ctx: ViewerContext, statuses: StatusMap): void {
  let target = null;
  let deepestY = -Infinity;

  for (const node of ctx.layoutNodes) {
    if (node.uid === undefined) continue;
    const st = statuses[String(node.uid)];
    if (st !== "RUNNING") continue;
    // Pick the running node furthest down the tree (deepest Y)
    if (node._y > deepestY) {
      deepestY = node._y;
      target = node;
    }
  }

  if (!target) return;

  const containerRect = ctx.container.getBoundingClientRect();
  // Keep zoomed out enough to see context around the active node
  const targetZoom = Math.min(Math.max(ctx.zoom, 0.4), 0.7);
  const targetPanX = -target._x * targetZoom + containerRect.width / 2 - (target._w * targetZoom) / 2;
  const targetPanY = -target._y * targetZoom + containerRect.height / 2 - (target._h * targetZoom) / 2;

  // Smooth follow
  ctx.panX += (targetPanX - ctx.panX) * 0.2;
  ctx.panY += (targetPanY - ctx.panY) * 0.2;
  ctx.zoom += (targetZoom - ctx.zoom) * 0.15;
  updateTransform(ctx);
}

export function clearMonitorOverlay(ctx: ViewerContext): void {
  ctx.lastNodeStatuses = {};
  if (ctx.idleFadeTimer) { clearTimeout(ctx.idleFadeTimer); ctx.idleFadeTimer = null; }
  const svgEl = document.getElementById("tree-group");
  if (svgEl) svgEl.classList.remove("monitor-faded");
  for (const node of ctx.layoutNodes) {
    const el = ctx.nodeElements.get(node.id);
    if (!el) continue;
    el.classList.remove("status-idle", "status-running", "status-success", "status-failure", "status-skipped", "subtree-active");
  }
  drawMinimap(ctx);
}
