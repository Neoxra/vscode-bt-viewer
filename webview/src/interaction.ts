/**
 * @fileoverview Pointer interaction: node dragging with animated overlap
 * settling, hover tooltip, background pan, wheel zoom, and the camera helpers
 * (updateTransform, fitToView, screen-space conversion).
 */

import { SIBLING_GAP } from "./constants";
import { BTNode, ViewerContext } from "./context";
import { updateAllEdges } from "./layout";
import { drawMinimap } from "./minimap";

// ------ NODE DRAGGING ------

export function startNodeDrag(ctx: ViewerContext, e: MouseEvent, node: BTNode): void {
  ctx.drag.node = node;
  const svgPoint = screenToSvg(ctx, e.clientX, e.clientY);
  ctx.drag.offsetX = svgPoint.x - node._x;
  ctx.drag.offsetY = svgPoint.y - node._y;
  hideTooltip(ctx);

  const el = ctx.scene.nodeElements.get(node.id);
  if (el) el.classList.add("dragging");
}

function handleNodeDrag(ctx: ViewerContext, e: MouseEvent): void {
  if (!ctx.drag.node) return;

  const svgPoint = screenToSvg(ctx, e.clientX, e.clientY);
  const newX = svgPoint.x - ctx.drag.offsetX;
  const newY = svgPoint.y - ctx.drag.offsetY;
  const dx = newX - ctx.drag.node._x;
  const dy = newY - ctx.drag.node._y;

  // Just move the subtree, no collision during drag
  moveSubtreeBy(ctx, ctx.drag.node, dx, dy);
  updateAllNodePositions(ctx);
  updateAllEdges(ctx);
}

function endNodeDrag(ctx: ViewerContext): void {
  if (ctx.drag.node) {
    const el = ctx.scene.nodeElements.get(ctx.drag.node.id);
    if (el) el.classList.remove("dragging");

    ctx.drag.node = null;
    // On release: resolve all overlaps with animated settle
    animateSettle(ctx);
  }
}

/** Move a node and all its (non-collapsed) descendants by dx, dy. */
function moveSubtreeBy(ctx: ViewerContext, node: BTNode, dx: number, dy: number): void {
  node._x += dx;
  node._y += dy;
  const isCollapsed = ctx.view.collapsedNodes.has(node.id);
  if (!isCollapsed && node.children) {
    for (const child of node.children) {
      moveSubtreeBy(ctx, child, dx, dy);
    }
  }
}

/**
 * After mouse release, resolve all overlaps (including cascades),
 * then animate from current positions to final positions.
 */
function animateSettle(ctx: ViewerContext): void {
  const gap = SIBLING_GAP;

  // 1. Snapshot current positions as animation start
  const startPos = new Map<string, { x: number; y: number }>();
  for (const node of ctx.scene.layoutNodes) {
    startPos.set(node.id, { x: node._x, y: node._y });
  }

  // 2. Iteratively resolve ALL overlaps (multi-pass, max 6 iterations)
  for (let pass = 0; pass < 6; pass++) {
    let anyPushed = false;

    for (let i = 0; i < ctx.scene.layoutNodes.length; i++) {
      const a = ctx.scene.layoutNodes[i];
      for (let j = i + 1; j < ctx.scene.layoutNodes.length; j++) {
        const b = ctx.scene.layoutNodes[j];

        const hOverlap = Math.min(a._x + a._w, b._x + b._w) - Math.max(a._x, b._x);
        const vOverlap = Math.min(a._y + a._h, b._y + b._h) - Math.max(a._y, b._y);
        if (hOverlap <= 0 || vOverlap <= 0) continue;

        // They overlap - push them apart horizontally
        const push = (hOverlap + gap) / 2;
        const aCx = a._x + a._w / 2;
        const bCx = b._x + b._w / 2;

        if (aCx <= bCx) {
          moveSubtreeBy(ctx, a, -push, 0);
          moveSubtreeBy(ctx, b, push, 0);
        } else {
          moveSubtreeBy(ctx, a, push, 0);
          moveSubtreeBy(ctx, b, -push, 0);
        }
        anyPushed = true;
      }
    }

    if (!anyPushed) break;
  }

  // 3. Record final positions
  const endPos = new Map<string, { x: number; y: number }>();
  for (const node of ctx.scene.layoutNodes) {
    endPos.set(node.id, { x: node._x, y: node._y });
  }

  // 4. Check if anything actually moved
  let anyMoved = false;
  for (const node of ctx.scene.layoutNodes) {
    const s = startPos.get(node.id)!;
    const e = endPos.get(node.id)!;
    if (Math.abs(s.x - e.x) > 0.5 || Math.abs(s.y - e.y) > 0.5) {
      anyMoved = true;
      break;
    }
  }
  if (!anyMoved) return;

  // 5. Reset to start positions, then animate to end
  for (const node of ctx.scene.layoutNodes) {
    const s = startPos.get(node.id)!;
    node._x = s.x;
    node._y = s.y;
  }

  const duration = 250;
  const startTime = performance.now();

  function tick(now: number): void {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic

    for (const node of ctx.scene.layoutNodes) {
      const s = startPos.get(node.id)!;
      const e = endPos.get(node.id)!;
      node._x = s.x + (e.x - s.x) * ease;
      node._y = s.y + (e.y - s.y) * ease;
    }

    updateAllNodePositions(ctx);
    updateAllEdges(ctx);

    if (t < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

/** Sync all node DOM elements to their current _x, _y positions. */
function updateAllNodePositions(ctx: ViewerContext): void {
  for (const node of ctx.scene.layoutNodes) {
    const el = ctx.scene.nodeElements.get(node.id);
    if (el) {
      el.setAttribute("transform", `translate(${node._x}, ${node._y})`);
    }
  }
}

/** Convert screen coordinates to SVG/tree coordinate space. */
function screenToSvg(ctx: ViewerContext, clientX: number, clientY: number): { x: number; y: number } {
  const rect = ctx.container.getBoundingClientRect();
  return {
    x: (clientX - rect.left - ctx.camera.panX) / ctx.camera.zoom,
    y: (clientY - rect.top - ctx.camera.panY) / ctx.camera.zoom,
  };
}

// ------ TOOLTIP ------

export function showTooltip(ctx: ViewerContext, event: MouseEvent, node: BTNode): void {
  if (ctx.drag.node) return; // No tooltip while dragging

  let html = `<div class="tt-title">${escHtml(node.name)}</div>`;
  html += `<div class="tt-type">${escHtml(node.type)} (${node.category})</div>`;

  if (node.ports.length > 0) {
    for (const port of node.ports) {
      html += `<div class="tt-port"><span class="port-name">${escHtml(port.name)}</span>: <span class="port-value">${escHtml(port.value)}</span></div>`;
    }
  }

  if (node.children && node.children.length > 0) {
    html += `<div class="tt-type" style="margin-top:4px">${node.children.length} children</div>`;
  }

  ctx.tooltip.innerHTML = html;
  ctx.tooltip.classList.remove("hidden");

  const x = event.clientX + 12;
  const y = event.clientY + 12;
  ctx.tooltip.style.left = x + "px";
  ctx.tooltip.style.top = y + "px";

  const rect = ctx.tooltip.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    ctx.tooltip.style.left = (event.clientX - rect.width - 12) + "px";
  }
  if (rect.bottom > window.innerHeight) {
    ctx.tooltip.style.top = (event.clientY - rect.height - 12) + "px";
  }
}

export function hideTooltip(ctx: ViewerContext): void {
  ctx.tooltip.classList.add("hidden");
}

export function escHtml(str: string | null | undefined): string {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ------ PAN & ZOOM ------

export function updateTransform(ctx: ViewerContext): void {
  ctx.treeGroup.setAttribute("transform", `translate(${ctx.camera.panX}, ${ctx.camera.panY}) scale(${ctx.camera.zoom})`);
  ctx.zoomLevelEl.textContent = Math.round(ctx.camera.zoom * 100) + "%";
  drawMinimap(ctx);
}

export function fitToView(ctx: ViewerContext): void {
  if (ctx.scene.layoutNodes.length === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of ctx.scene.layoutNodes) {
    minX = Math.min(minX, node._x);
    minY = Math.min(minY, node._y);
    maxX = Math.max(maxX, node._x + node._w);
    maxY = Math.max(maxY, node._y + node._h);
  }

  const treeW = maxX - minX || 1;
  const treeH = maxY - minY || 1;
  const containerRect = ctx.container.getBoundingClientRect();

  if (containerRect.width < 10 || containerRect.height < 10) {
    setTimeout(() => fitToView(ctx), 100);
    return;
  }

  const padX = 40;
  const padY = 50;

  const scaleX = (containerRect.width - padX * 2) / treeW;
  const scaleY = (containerRect.height - padY * 2) / treeH;
  ctx.camera.zoom = Math.min(scaleX, scaleY, 1.5);
  ctx.camera.zoom = Math.max(ctx.camera.zoom, 0.15);

  ctx.camera.panX = (containerRect.width - treeW * ctx.camera.zoom) / 2 - minX * ctx.camera.zoom;
  ctx.camera.panY = padY - minY * ctx.camera.zoom;

  updateTransform(ctx);
}

/** Wire background pan, node-drag routing, wheel zoom, and tooltip tracking. */
export function initPanZoom(ctx: ViewerContext): void {
  // Background pan: mousedown on SVG background
  ctx.container.addEventListener("mousedown", (e) => {
    // Only start pan if clicking on background (not a node)
    if (ctx.drag.node) return;
    ctx.camera.isPanning = true;
    ctx.camera.panStartX = e.clientX - ctx.camera.panX;
    ctx.camera.panStartY = e.clientY - ctx.camera.panY;
    ctx.container.classList.add("dragging");
  });

  window.addEventListener("mousemove", (e) => {
    if (ctx.drag.node) {
      handleNodeDrag(ctx, e);
      return;
    }
    if (ctx.camera.isPanning) {
      ctx.camera.panX = e.clientX - ctx.camera.panStartX;
      ctx.camera.panY = e.clientY - ctx.camera.panStartY;
      updateTransform(ctx);
    }
    // Update tooltip position
    if (!ctx.tooltip.classList.contains("hidden")) {
      ctx.tooltip.style.left = (e.clientX + 12) + "px";
      ctx.tooltip.style.top = (e.clientY + 12) + "px";
    }
  });

  window.addEventListener("mouseup", () => {
    if (ctx.drag.node) {
      endNodeDrag(ctx);
    }
    ctx.camera.isPanning = false;
    ctx.container.classList.remove("dragging");
  });

  ctx.container.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = ctx.container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const prevZoom = ctx.camera.zoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    ctx.camera.zoom = Math.max(0.1, Math.min(5, ctx.camera.zoom * delta));

    ctx.camera.panX = mouseX - (mouseX - ctx.camera.panX) * (ctx.camera.zoom / prevZoom);
    ctx.camera.panY = mouseY - (mouseY - ctx.camera.panY) * (ctx.camera.zoom / prevZoom);

    updateTransform(ctx);
  }, { passive: false });
}
