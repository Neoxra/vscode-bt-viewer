/**
 * @fileoverview Minimap: a canvas overview of the whole tree with the current
 * viewport rectangle, hidden when everything already fits on screen. Click or
 * drag on it to navigate.
 */

import { ViewerContext } from "./context";
import { getTreeBounds } from "./layout";
import { updateTransform } from "./interaction";

export function drawMinimap(ctx: ViewerContext): void {
  const { minimap, minimapCtx } = ctx;
  if (!minimapCtx || !minimap || ctx.scene.layoutNodes.length === 0) {
    if (minimap) minimap.style.display = "none";
    return;
  }
  const canvas = minimap;
  const cw = canvas.width;
  const ch = canvas.height;
  const c2d = minimapCtx;

  // Hide minimap if entire tree fits on screen
  const bounds = getTreeBounds(ctx);
  const containerRect = ctx.container.getBoundingClientRect();
  const viewL = -ctx.camera.panX / ctx.camera.zoom;
  const viewT = -ctx.camera.panY / ctx.camera.zoom;
  const viewR = viewL + containerRect.width / ctx.camera.zoom;
  const viewB = viewT + containerRect.height / ctx.camera.zoom;
  const allVisible = bounds.minX >= viewL && bounds.maxX <= viewR && bounds.minY >= viewT && bounds.maxY <= viewB;
  canvas.style.display = allVisible ? "none" : "block";
  if (allVisible) return;

  c2d.clearRect(0, 0, cw, ch);
  if (bounds.w <= 0 || bounds.h <= 0) return;

  // Scale tree to fit minimap with padding
  const pad = 6;
  const scaleX = (cw - pad * 2) / bounds.w;
  const scaleY = (ch - pad * 2) / bounds.h;
  const scale = Math.min(scaleX, scaleY);

  const ox = pad + (cw - pad * 2 - bounds.w * scale) / 2 - bounds.minX * scale;
  const oy = pad + (ch - pad * 2 - bounds.h * scale) / 2 - bounds.minY * scale;

  // Draw edges
  c2d.strokeStyle = (ctx.colors.status && ctx.colors.status.edge) || "#555";
  c2d.lineWidth = 0.5;
  for (const e of ctx.scene.edgeElements) {
    const src = ctx.scene.nodeById.get(e.sourceId);
    const tgt = ctx.scene.nodeById.get(e.targetId);
    if (!src || !tgt) continue;
    c2d.beginPath();
    c2d.moveTo(ox + (src._x + src._w / 2) * scale, oy + (src._y + src._h) * scale);
    c2d.lineTo(ox + (tgt._x + tgt._w / 2) * scale, oy + tgt._y * scale);
    c2d.stroke();
  }

  // Draw nodes as small colored rectangles
  for (const node of ctx.scene.layoutNodes) {
    const cat = node.category || "action";
    const color = ctx.colors[cat] || { fill: "#555" };

    const nx = ox + node._x * scale;
    const ny = oy + node._y * scale;
    const nw = Math.max(node._w * scale, 2);
    const nh = Math.max(node._h * scale, 1.5);

    // Highlight running nodes using the same palette as the SVG view.
    const el = ctx.scene.nodeElements.get(node.id);
    const status = ctx.colors.status || {};
    if (el && el.classList.contains("status-running")) {
      c2d.fillStyle = status.running || color.fill;
    } else if (el && el.classList.contains("status-success")) {
      c2d.fillStyle = status.success || color.fill;
    } else if (el && el.classList.contains("status-failure")) {
      c2d.fillStyle = status.failure || color.fill;
    } else {
      c2d.fillStyle = color.fill;
    }
    c2d.fillRect(nx, ny, nw, nh);
  }

  // Draw viewport rectangle (reuse containerRect from above)
  const vx = ox + (-ctx.camera.panX / ctx.camera.zoom) * scale;
  const vy = oy + (-ctx.camera.panY / ctx.camera.zoom) * scale;
  const vw = (containerRect.width / ctx.camera.zoom) * scale;
  const vh = (containerRect.height / ctx.camera.zoom) * scale;

  c2d.strokeStyle = (ctx.colors.status && ctx.colors.status.viewport) || "#fff";
  c2d.lineWidth = 1.5;
  c2d.strokeRect(vx, vy, vw, vh);
}

/** Wire click/drag navigation on the minimap canvas. */
export function initMinimap(ctx: ViewerContext): void {
  const { minimap } = ctx;
  if (!minimap) return;

  let minimapDragging = false;

  function minimapNavigate(e: MouseEvent): void {
    if (ctx.scene.layoutNodes.length === 0) return;
    const rect = minimap!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const bounds = getTreeBounds(ctx);
    if (bounds.w <= 0 || bounds.h <= 0) return;

    const cw = minimap!.width;
    const ch = minimap!.height;
    const pad = 6;
    const scaleX = (cw - pad * 2) / bounds.w;
    const scaleY = (ch - pad * 2) / bounds.h;
    const scale = Math.min(scaleX, scaleY);
    const ox = pad + (cw - pad * 2 - bounds.w * scale) / 2 - bounds.minX * scale;
    const oy = pad + (ch - pad * 2 - bounds.h * scale) / 2 - bounds.minY * scale;

    const containerRect = ctx.container.getBoundingClientRect();
    const treeX = (mx - ox) / scale;
    const treeY = (my - oy) / scale;

    ctx.camera.panX = -treeX * ctx.camera.zoom + containerRect.width / 2;
    ctx.camera.panY = -treeY * ctx.camera.zoom + containerRect.height / 2;
    updateTransform(ctx);
  }

  minimap.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    minimapDragging = true;
    minimapNavigate(e);
  });
  minimap.addEventListener("mousemove", (e) => {
    if (minimapDragging) minimapNavigate(e);
  });
  window.addEventListener("mouseup", () => { minimapDragging = false; });
}
