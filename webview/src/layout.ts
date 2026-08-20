/**
 * @fileoverview Layout engine: node measurement, tree positioning (horizontal
 * and waterfall modes), collapse/expand bookkeeping, edge path geometry, and
 * the layout-tree construction that inlines expanded SubTree references.
 */

import {
  CHAR_WIDTH,
  LEVEL_GAP,
  NODE_MIN_W,
  NODE_PADDING_X,
  PORT_LINE_H,
  SIBLING_GAP,
} from "./constants";
import { StatusMap } from "../../shared/protocol";
import { BTNode, LayoutEdge, Tree, ViewerContext } from "./context";

export const LINE_H = 13; // Height per line of text
const MAX_CHARS_PER_LINE = 22; // Wrap threshold

/** Split text into wrapped lines. */
function wrapText(str: string, maxChars: number): string[] {
  if (!str || str.length <= maxChars) return [str || ""];
  const lines: string[] = [];
  let remaining = str;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      lines.push(remaining);
      break;
    }
    // Try to break at a word boundary
    let breakAt = remaining.lastIndexOf(" ", maxChars);
    if (breakAt <= 0) breakAt = remaining.lastIndexOf("_", maxChars);
    if (breakAt <= 0) breakAt = maxChars;
    lines.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).trimStart();
  }
  return lines;
}

/** Pre-compute wrapped lines for a node. */
export function computeNodeLines(node: BTNode): void {
  node._nameLines = wrapText(node.name, MAX_CHARS_PER_LINE);
  node._typeLines = (node.type !== node.name) ? wrapText(node.type, MAX_CHARS_PER_LINE) : [];
  node._portLines = node.ports.map(p => {
    const s = `${p.name}: ${p.value}`;
    return wrapText(s, MAX_CHARS_PER_LINE + 4); // ports use smaller font, allow more
  });
}

function nodeWidth(node: BTNode): number {
  if (!node._nameLines) computeNodeLines(node);
  let maxLen = 0;
  for (const l of node._nameLines) maxLen = Math.max(maxLen, l.length);
  for (const l of node._typeLines) maxLen = Math.max(maxLen, l.length * 0.85);
  for (const pl of node._portLines) {
    for (const l of pl) maxLen = Math.max(maxLen, l.length * 0.75);
  }
  return Math.max(NODE_MIN_W, maxLen * CHAR_WIDTH + NODE_PADDING_X * 2);
}

function nodeHeight(node: BTNode): number {
  if (!node._nameLines) computeNodeLines(node);
  const nameH = node._nameLines.length * LINE_H;
  const typeH = node._typeLines.length * LINE_H;
  let portH = 0;
  for (const pl of node._portLines) portH += pl.length * PORT_LINE_H;
  return 8 + nameH + typeH + portH + 4; // padding top + content + padding bottom
}

const WATERFALL_THRESHOLD = 20; // Subtrees with 20+ visible nodes use waterfall
export const STEM_GAP = 20; // Gap between left stem line and child nodes

/** Count visible (non-collapsed) nodes in a subtree. Cached on node as _visCount. */
export function countVisibleNodes(ctx: ViewerContext, node: BTNode): number {
  if (node._visCount !== undefined) return node._visCount;
  let count = 1;
  if (!ctx.view.collapsedNodes.has(node.id)) {
    for (const child of (node.children || [])) {
      count += countVisibleNodes(ctx, child);
    }
  }
  node._visCount = count;
  return count;
}

/**
 * Layout engine with two modes:
 *  - Small trees: pure horizontal (classic top-down tree)
 *  - Large trees: waterfall (stem on left, children indented right)
 *
 * In waterfall mode, the stem runs down the LEFT side of the parent node.
 * Children are placed to the RIGHT, clear of the stem.
 */
function measureSubtree(ctx: ViewerContext, node: BTNode): void {
  const w = nodeWidth(node);
  const h = nodeHeight(node);
  node._w = w;
  node._h = h;
  const isCollapsed = ctx.view.collapsedNodes.has(node.id);
  const children = isCollapsed ? [] : (node.children || []);

  if (children.length === 0) {
    node._subtreeW = w;
    node._subtreeH = h;
    return;
  }

  for (const child of children) measureSubtree(ctx, child);

  // Decide layout: manual override or auto based on subtree size
  const subtreeSize = countVisibleNodes(ctx, node);
  const goVertical = ctx.view.layoutMode === "waterfall" ? (children.length > 1)
    : ctx.view.layoutMode === "horizontal" ? false
    : (subtreeSize >= WATERFALL_THRESHOLD && children.length > 1);

  if (goVertical) {
    // Waterfall: children stacked vertically, indented right of parent
    let maxChildW = 0;
    let totalChildH = 0;
    for (let i = 0; i < children.length; i++) {
      maxChildW = Math.max(maxChildW, children[i]._subtreeW);
      totalChildH += children[i]._subtreeH;
      if (i < children.length - 1) totalChildH += SIBLING_GAP;
    }
    const indent = STEM_GAP + SIBLING_GAP;
    node._subtreeW = w + indent + maxChildW;
    node._subtreeH = h + LEVEL_GAP + totalChildH;
    node._vertical = true;
  } else {
    // Horizontal: children side by side below parent
    let totalW = 0;
    let maxChildH = 0;
    for (let i = 0; i < children.length; i++) {
      totalW += children[i]._subtreeW;
      if (i < children.length - 1) totalW += SIBLING_GAP;
      maxChildH = Math.max(maxChildH, children[i]._subtreeH);
    }
    node._subtreeW = Math.max(w, totalW);
    node._subtreeH = h + LEVEL_GAP + maxChildH;
    node._vertical = false;
  }
}

function positionSubtree(ctx: ViewerContext, node: BTNode, offsetX: number, offsetY: number): void {
  const isCollapsed = ctx.view.collapsedNodes.has(node.id);
  const children = isCollapsed ? [] : (node.children || []);

  if (node._vertical && children.length > 1) {
    // Waterfall: parent at top-left, children stacked to the right
    // Parent is left-aligned in its allocated space
    node._x = offsetX;
    node._y = offsetY;

    const childX = offsetX + STEM_GAP + SIBLING_GAP;
    let cy = offsetY + node._h + LEVEL_GAP;
    for (let i = 0; i < children.length; i++) {
      positionSubtree(ctx, children[i], childX, cy);
      cy += children[i]._subtreeH + SIBLING_GAP;
    }
  } else {
    // Horizontal: parent centered above children
    if (children.length === 0) {
      node._x = offsetX + (node._subtreeW - node._w) / 2;
      node._y = offsetY;
      return;
    }

    let totalW = 0;
    for (let i = 0; i < children.length; i++) {
      totalW += children[i]._subtreeW;
      if (i < children.length - 1) totalW += SIBLING_GAP;
    }

    // Center parent over children
    node._x = offsetX + (node._subtreeW - node._w) / 2;
    node._y = offsetY;

    const startX = offsetX + (node._subtreeW - totalW) / 2;
    const childY = offsetY + node._h + LEVEL_GAP;
    let cx = startX;
    for (let i = 0; i < children.length; i++) {
      positionSubtree(ctx, children[i], cx, childY);
      cx += children[i]._subtreeW + SIBLING_GAP;
    }
  }
}

/**
 * Auto-collapse nodes deeper than maxDepth.
 * Nodes at exactly maxDepth that have children get collapsed.
 */
export function autoCollapseDepth(ctx: ViewerContext, node: BTNode, depth: number, maxDepth: number): void {
  if (!node.children || node.children.length === 0) return;
  if (depth >= maxDepth) {
    ctx.view.collapsedNodes.add(node.id);
    return;
  }
  for (const child of node.children) {
    autoCollapseDepth(ctx, child, depth + 1, maxDepth);
  }
}

/**
 * During follow mode: additively expand the path to running nodes. Returns
 * true if this node or any descendant is running. Follow is purely additive:
 * it never collapses other branches, so the user's own expand/collapse state
 * is preserved (the camera, not collapsing, keeps the active node in view).
 * `changed` is an accumulator ({ value }) set to true only when this call
 * actually mutates collapsedNodes, so the caller can re-render only on a real
 * structural change rather than on every frame that has a running node.
 */
export function expandRunningPath(
  ctx: ViewerContext,
  node: BTNode,
  statuses: StatusMap,
  changed: { value: boolean },
): boolean {
  if (!node.children || node.children.length === 0) {
    return node.uid !== undefined && statuses[String(node.uid)] === "RUNNING";
  }

  let anyRunning = node.uid !== undefined && statuses[String(node.uid)] === "RUNNING";

  for (const child of node.children) {
    if (expandRunningPath(ctx, child, statuses, changed)) {
      anyRunning = true;
    }
  }

  // On the running path: expand it. Set.delete reports whether it removed
  // anything, so we only flag a genuine change.
  if (anyRunning && ctx.view.collapsedNodes.delete(node.id)) {
    changed.value = true;
  }

  return anyRunning;
}

export function layoutTree(ctx: ViewerContext, node: BTNode): void {
  // Clear cached counts from previous layout
  function clearCache(n: BTNode): void {
    n._visCount = undefined;
    for (const c of (n.children || [])) clearCache(c);
  }
  clearCache(node);

  measureSubtree(ctx, node);
  positionSubtree(ctx, node, 0, 0);
}

export function flattenTree(
  ctx: ViewerContext,
  node: BTNode,
  nodes: BTNode[],
  edges: LayoutEdge[],
  parent: BTNode | null,
): void {
  nodes.push(node);
  if (parent) ctx.scene.parentMap.set(node.id, parent);
  const isCollapsed = ctx.view.collapsedNodes.has(node.id);
  const children = isCollapsed ? [] : (node.children || []);

  for (const child of children) {
    edges.push({ sourceId: node.id, targetId: child.id, vertical: !!node._vertical });
    flattenTree(ctx, child, nodes, edges, node);
  }
}

export function edgePath(source: BTNode, target: BTNode, vertical: boolean): string {
  if (vertical) {
    // Waterfall / org-chart style:
    // Stem runs down from parent's bottom-left corner
    // Then turns right to connect to child's left edge at mid-height
    const stemX = source._x + STEM_GAP / 2;
    const y1 = source._y + source._h;
    const y2mid = target._y + target._h / 2;
    const x2 = target._x;
    const r = 5; // corner radius

    // Clamp radius to available space
    const dy = Math.abs(y2mid - y1);
    const dx = Math.abs(x2 - stemX);
    const cr = Math.min(r, dy / 2, dx / 2);

    return `M ${stemX} ${y1}` +                                    // start at parent bottom-left area
           ` L ${stemX} ${y2mid - cr}` +                           // down the stem
           ` Q ${stemX} ${y2mid}, ${stemX + cr} ${y2mid}` +       // rounded corner
           ` L ${x2} ${y2mid}`;                                    // right to child
  }

  // Horizontal: smooth bezier from parent bottom-center to child top-center
  const x1 = source._x + source._w / 2;
  const y1 = source._y + source._h;
  const x2 = target._x + target._w / 2;
  const y2 = target._y;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

export function updateAllEdges(ctx: ViewerContext): void {
  for (const e of ctx.scene.edgeElements) {
    const source = ctx.scene.nodeById.get(e.sourceId);
    const target = ctx.scene.nodeById.get(e.targetId);
    if (source && target) {
      e.path.setAttribute("d", edgePath(source, target, e.vertical));
    }
  }
}

/**
 * Build a layout-time copy of a tree where SubTree nodes that the user has
 * expanded inline the referenced tree's children as their own. Node ids are
 * namespaced by path so the same referenced tree can be expanded in
 * multiple places without colliding. Original parser nodes are NOT
 * mutated; the returned tree is a fresh structure for layout to consume.
 */
export function buildLayoutTree(
  ctx: ViewerContext,
  node: BTNode,
  pathPrefix: string,
  visited: Set<string>,
  sourceFile: string | undefined,
): BTNode {
  const layoutId = pathPrefix ? `${pathPrefix}/${node.id}` : node.id;
  const out: BTNode = { ...node, id: layoutId, _origId: node.id, _sourceFile: sourceFile };
  if (
    node.category === "subtree" &&
    ctx.view.expandedSubtrees.has(layoutId) &&
    ctx.treeData && ctx.treeData.trees
  ) {
    const refName = (node.ports.find(p => p.name === "ID") || {}).value || node.name;
    const refTree = ctx.treeData.trees.find(t => t.id === refName);
    if (refTree && refTree.root && !visited.has(refName)) {
      const nextVisited = new Set(visited); nextVisited.add(refName);
      const childSourceFile = refTree.sourceFile || sourceFile;
      out.children = (refTree.root.children || []).map(
        c => buildLayoutTree(ctx, c, layoutId, nextVisited, childSourceFile)
      );
      return out;
    }
  }
  out.children = (node.children || []).map(c => buildLayoutTree(ctx, c, pathPrefix, visited, sourceFile));
  return out;
}

/** Resolve the currently-selected tree (falls back to the main/first tree). */
export function getActiveTree(ctx: ViewerContext): Tree | null {
  if (!ctx.treeData || !ctx.treeData.trees) return null;
  const treeId = ctx.view.selectedTreeId || ctx.treeData.mainTreeId;
  return ctx.treeData.trees.find(t => t.id === treeId) || ctx.treeData.trees[0] || null;
}

/**
 * Inline every SubTree instance. Nested SubTrees only appear once their parent
 * is inlined, so iterate: expand what's visible, rebuild, repeat until stable.
 * buildLayoutTree's visited guard bounds recursion; the counter is a backstop.
 */
export function expandAllSubtrees(ctx: ViewerContext, tree: Tree): void {
  const maxPasses = 100; // backstop; buildLayoutTree's visited guard bounds real recursion
  let added = true;
  let guard = 0;
  while (added && guard++ < maxPasses) {
    added = false;
    const layoutRoot = buildLayoutTree(ctx, tree.root, "", new Set([tree.id]), tree.sourceFile);
    const stack = [layoutRoot];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.category === "subtree" && !ctx.view.expandedSubtrees.has(n.id)) {
        const refName = (n.ports.find(p => p.name === "ID") || {}).value || n.name;
        if (ctx.treeData!.trees.some(t => t.id === refName)) {
          ctx.view.expandedSubtrees.add(n.id);
          added = true;
        }
      }
      for (const c of (n.children || [])) stack.push(c);
    }
  }
}

export interface TreeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
}

export function getTreeBounds(ctx: ViewerContext): TreeBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of ctx.scene.layoutNodes) {
    minX = Math.min(minX, node._x);
    minY = Math.min(minY, node._y);
    maxX = Math.max(maxX, node._x + node._w);
    maxY = Math.max(maxY, node._y + node._h);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}
