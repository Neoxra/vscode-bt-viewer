/**
 * @fileoverview Rendering: turns the selected tree into SVG nodes and edges,
 * including the collapse chevrons, collapsed-count badges, category legend,
 * and per-node pointer wiring (tooltip, drag, detail panel, go-to-source).
 */

import { NODE_FILL_OPACITY, PORT_LINE_H } from "./constants";
import { LINE_H } from "./layout";
import { BTNode, ViewerContext } from "./context";
import {
  buildLayoutTree,
  computeNodeLines,
  edgePath,
  flattenTree,
  layoutTree,
} from "./layout";
import { hideTooltip, showTooltip, startNodeDrag, updateTransform } from "./interaction";
import { showNodeDetail } from "./sidePanels";

export function render(ctx: ViewerContext): void {
  if (!ctx.treeData || !ctx.treeData.trees || ctx.treeData.trees.length === 0) return;

  const treeId = ctx.view.selectedTreeId || ctx.treeData.mainTreeId;
  const mainTreeRaw = ctx.treeData.trees.find(t => t.id === treeId) || ctx.treeData.trees[0];
  if (!mainTreeRaw || !mainTreeRaw.root) return;

  // Build layout tree with SubTree expansions inlined. The source file
  // propagates so every layout node knows which file its line refers to.
  const mainTree = {
    id: mainTreeRaw.id,
    root: buildLayoutTree(
      ctx,
      mainTreeRaw.root,
      "",
      new Set([mainTreeRaw.id]),
      mainTreeRaw.sourceFile,
    ),
  };

  // When viewing a subtree (not the main tree), mark root as subtree category
  // so it keeps the purple color matching the SubTree reference node
  if (treeId !== ctx.treeData.mainTreeId && mainTree.root._origCategory === undefined) {
    mainTree.root._origCategory = mainTree.root.category;
    mainTree.root.category = "subtree";
  }

  // Layout
  layoutTree(ctx, mainTree.root);
  ctx.scene.layoutNodes = [];
  ctx.scene.layoutEdges = [];
  ctx.scene.parentMap.clear();
  flattenTree(ctx, mainTree.root, ctx.scene.layoutNodes, ctx.scene.layoutEdges, null);

  // Build lookup
  ctx.scene.nodeById.clear();
  for (const node of ctx.scene.layoutNodes) {
    ctx.scene.nodeById.set(node.id, node);
  }

  // Clear
  ctx.edgeGroup.innerHTML = "";
  ctx.nodeGroup.innerHTML = "";
  ctx.scene.nodeElements.clear();
  ctx.scene.edgeElements = [];

  // Render edges
  for (const edge of ctx.scene.layoutEdges) {
    const source = ctx.scene.nodeById.get(edge.sourceId);
    const target = ctx.scene.nodeById.get(edge.targetId);
    if (!source || !target) continue;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "bt-edge");
    path.setAttribute("d", edgePath(source, target, edge.vertical));
    ctx.edgeGroup.appendChild(path);
    ctx.scene.edgeElements.push({ path, sourceId: edge.sourceId, targetId: edge.targetId, vertical: edge.vertical });
  }

  // Render nodes
  for (const node of ctx.scene.layoutNodes) {
    const g = createNodeElement(ctx, node);
    ctx.nodeGroup.appendChild(g);
    ctx.scene.nodeElements.set(node.id, g);
  }

  // Add legend
  renderLegend(ctx);
  updateTransform(ctx);
}

function createNodeElement(ctx: ViewerContext, node: BTNode): SVGGElement {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "bt-node");
  g.setAttribute("transform", `translate(${node._x}, ${node._y})`);
  g.dataset.nodeId = node.id;

  const cat = node.category || "action";
  const color = ctx.colors[cat] || { fill: "#555", stroke: "#444", text: "#fff" };

  // Node rectangle
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("width", String(node._w));
  rect.setAttribute("height", String(node._h));
  rect.setAttribute("fill", color.fill);
  rect.setAttribute("fill-opacity", String(NODE_FILL_OPACITY));
  rect.setAttribute("stroke", color.stroke);
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("rx", "6");
  rect.setAttribute("ry", "6");
  g.appendChild(rect);

  // Category icon
  const iconSize = 6;
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  icon.setAttribute("x", "6");
  icon.setAttribute("y", "6");
  icon.setAttribute("width", String(iconSize));
  icon.setAttribute("height", String(iconSize));
  icon.setAttribute("fill", color.text);
  icon.setAttribute("opacity", "0.4");
  icon.setAttribute("rx", cat === "control" ? "0" : cat === "decorator" ? "3" : "1");
  g.appendChild(icon);

  // Render wrapped text lines
  if (!node._nameLines) computeNodeLines(node);
  let curY = 6 + LINE_H; // Start after top padding

  // Name lines
  for (const line of node._nameLines) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(node._w / 2));
    t.setAttribute("y", String(curY));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("fill", color.text);
    t.setAttribute("class", "node-label");
    t.textContent = line;
    g.appendChild(t);
    curY += LINE_H;
  }

  // Type lines
  for (const line of node._typeLines) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(node._w / 2));
    t.setAttribute("y", String(curY));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("fill", color.text);
    t.setAttribute("class", "node-type");
    t.textContent = line;
    g.appendChild(t);
    curY += LINE_H;
  }

  // Port lines
  for (const portWrapped of node._portLines) {
    for (const line of portWrapped) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", String(node._w / 2));
      t.setAttribute("y", String(curY));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", color.text);
      t.setAttribute("class", "node-port");
      t.textContent = line;
      g.appendChild(t);
      curY += PORT_LINE_H;
    }
  }

  // Whether this node is a SubTree whose referenced tree is resolved -- we
  // give those a chevron too (to inline / re-collapse their children), even
  // though SubTree nodes have no inline children of their own.
  const isExpandableSubtree =
    node.category === "subtree" &&
    !!ctx.treeData && !!ctx.treeData.trees &&
    (() => {
      const refName = (node.ports.find(p => p.name === "ID") || {}).value || node.name;
      return !!refName && ctx.treeData!.trees.some(t => t.id === refName);
    })();
  const isSubtreeExpanded = isExpandableSubtree && ctx.view.expandedSubtrees.has(node.id);

  // Collapse/expand chevron button. SubTree nodes get a chevron whenever
  // their reference resolves; regular nodes get one when they have children.
  if ((node.children && node.children.length > 0) || isExpandableSubtree) {
    const isCollapsed = ctx.view.collapsedNodes.has(node.id);
    // Open == chevron points down (children visible). For SubTrees, "open"
    // means we've inlined the referenced tree.
    const isOpen = isExpandableSubtree ? isSubtreeExpanded : !isCollapsed;

    // Clickable hit area for the chevron
    const chevronHit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    chevronHit.setAttribute("x", String(node._w - 18));
    chevronHit.setAttribute("y", "2");
    chevronHit.setAttribute("width", "16");
    chevronHit.setAttribute("height", "16");
    chevronHit.setAttribute("fill", "transparent");
    chevronHit.setAttribute("class", "collapse-chevron-hit");
    g.appendChild(chevronHit);

    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "text");
    chevron.setAttribute("x", String(node._w - 10));
    chevron.setAttribute("y", "13");
    chevron.setAttribute("text-anchor", "middle");
    chevron.setAttribute("class", "collapse-chevron");
    chevron.setAttribute("fill", color.text);
    chevron.textContent = isOpen ? "▼" : "▶";
    g.appendChild(chevron);

    // Click chevron to toggle. For SubTree nodes we flip expandedSubtrees
    // (which triggers buildLayoutTree to inline the reference on next
    // render); for regular nodes we keep the original collapsedNodes flow.
    function toggleCollapse(ev: Event): void {
      ev.stopPropagation();
      const oldX = node._x;
      const oldY = node._y;
      if (isExpandableSubtree) {
        if (ctx.view.expandedSubtrees.has(node.id)) ctx.view.expandedSubtrees.delete(node.id);
        else ctx.view.expandedSubtrees.add(node.id);
      } else {
        if (ctx.view.collapsedNodes.has(node.id)) ctx.view.collapsedNodes.delete(node.id);
        else ctx.view.collapsedNodes.add(node.id);
      }
      const savedZoom = ctx.camera.zoom;
      render(ctx);
      const updatedNode = ctx.scene.nodeById.get(node.id);
      if (updatedNode) {
        ctx.camera.panX -= (updatedNode._x - oldX) * savedZoom;
        ctx.camera.panY -= (updatedNode._y - oldY) * savedZoom;
      }
      ctx.camera.zoom = savedZoom;
      updateTransform(ctx);
    }
    chevronHit.addEventListener("click", toggleCollapse);
    chevron.addEventListener("click", toggleCollapse);

    // Badge with hidden child count when collapsed
    if (isCollapsed) {
      const badgeX = node._w / 2;
      const badgeY = node._h + 8;
      const badgeW = 28;
      const badgeH = 14;

      const badgeRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      badgeRect.setAttribute("x", String(badgeX - badgeW / 2));
      badgeRect.setAttribute("y", String(badgeY - badgeH / 2));
      badgeRect.setAttribute("width", String(badgeW));
      badgeRect.setAttribute("height", String(badgeH));
      badgeRect.setAttribute("rx", "7");
      badgeRect.setAttribute("fill", color.stroke);
      badgeRect.setAttribute("opacity", "0.8");
      g.appendChild(badgeRect);

      const badgeText = document.createElementNS("http://www.w3.org/2000/svg", "text");
      badgeText.setAttribute("x", String(badgeX));
      badgeText.setAttribute("y", String(badgeY + 4));
      badgeText.setAttribute("text-anchor", "middle");
      badgeText.setAttribute("class", "collapse-badge-text");
      badgeText.setAttribute("fill", color.text);
      badgeText.textContent = `+${node.children!.length}`;
      g.appendChild(badgeText);
    }
  }

  // Hover tooltip
  g.addEventListener("mouseenter", (e) => showTooltip(ctx, e, node));
  g.addEventListener("mouseleave", () => hideTooltip(ctx));

  // Click: show node info. Drag: move node. We distinguish by tracking movement.
  let clickStartX = 0;
  let clickStartY = 0;

  g.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    clickStartX = e.clientX;
    clickStartY = e.clientY;
    startNodeDrag(ctx, e, node);
  });

  g.addEventListener("click", (e) => {
    e.stopPropagation();
    const dist = Math.abs(e.clientX - clickStartX) + Math.abs(e.clientY - clickStartY);
    if (dist >= 5) return;
    // Ctrl/Cmd-click jumps to where this node is defined in the XML
    // source. Each node carries its own source file (set by buildLayoutTree)
    // so clicks on nodes inlined from a SubTree open the referenced file,
    // while the SubTree node itself opens its call site in the main file.
    if (e.ctrlKey || e.metaKey) {
      if (node.xmlLine) {
        ctx.vscode.postMessage({
          command: "goToLine",
          line: node.xmlLine,
          file: node._sourceFile,
        });
      }
      return;
    }
    showNodeDetail(ctx, node);
  });

  return g;
}

function renderLegend(ctx: ViewerContext): void {
  const oldLegend = document.getElementById("legend");
  if (oldLegend) oldLegend.remove();

  const legend = document.createElement("div");
  legend.id = "legend";

  const categories = ["control", "decorator", "action", "condition", "subtree", "script"];
  for (const cat of categories) {
    const color = ctx.colors[cat];
    if (!color) continue;
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("div");
    swatch.className = "legend-swatch";
    swatch.style.background = color.fill;
    const label = document.createElement("span");
    label.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
    item.appendChild(swatch);
    item.appendChild(label);
    legend.appendChild(item);
  }

  ctx.container.appendChild(legend);
}
