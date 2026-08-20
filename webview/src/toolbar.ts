/**
 * @fileoverview Toolbar wiring: tree selector, search, view layout cycling,
 * Expand All / Reset / Depth, the Monitor and Follow toggles, and the
 * fit/zoom/PDF buttons.
 */

import { ViewerContext } from "./context";
import { fitToView, updateTransform } from "./interaction";
import { autoCollapseDepth, expandAllSubtrees, getActiveTree } from "./layout";
import { clearMonitorOverlay, reapplyStatusOverlay, updateFollowButtonState } from "./monitor";
import { exportTreeToPdf } from "./pdfExport";
import { render } from "./render";

export function populateTreeSelector(ctx: ViewerContext): void {
  ctx.treeSelector.innerHTML = "";
  if (!ctx.treeData || !ctx.treeData.trees) return;
  for (const tree of ctx.treeData.trees) {
    const opt = document.createElement("option");
    opt.value = tree.id;
    opt.textContent = tree.id;
    if (tree.id === (ctx.selectedTreeId || ctx.treeData.mainTreeId)) opt.selected = true;
    ctx.treeSelector.appendChild(opt);
  }
}

export function applySearch(ctx: ViewerContext): void {
  let matchCount = 0;
  for (const node of ctx.layoutNodes) {
    const el = ctx.nodeElements.get(node.id);
    if (!el) continue;

    if (!ctx.searchQuery) {
      el.classList.remove("search-match", "search-dim");
      continue;
    }

    const text = (node.name + " " + node.type).toLowerCase();
    const portText = node.ports.map(p => p.name + " " + p.value).join(" ").toLowerCase();
    const isMatch = text.includes(ctx.searchQuery) || portText.includes(ctx.searchQuery);

    el.classList.toggle("search-match", isMatch);
    el.classList.toggle("search-dim", !isMatch);
    if (isMatch) matchCount++;
  }

  ctx.searchCount.textContent = ctx.searchQuery ? `${matchCount} found` : "";
}

/** Wire every toolbar control. Call once at startup. */
export function initToolbar(ctx: ViewerContext): void {
  ctx.btnFit.addEventListener("click", () => fitToView(ctx));
  ctx.btnZoomIn.addEventListener("click", () => {
    ctx.zoom = Math.min(5, ctx.zoom * 1.2);
    updateTransform(ctx);
  });
  ctx.btnZoomOut.addEventListener("click", () => {
    ctx.zoom = Math.max(0.1, ctx.zoom / 1.2);
    updateTransform(ctx);
  });
  if (ctx.btnExportPdf) {
    ctx.btnExportPdf.addEventListener("click", () => { void exportTreeToPdf(ctx); });
  }

  ctx.treeSelector.addEventListener("change", () => {
    ctx.selectedTreeId = ctx.treeSelector.value;
    ctx.collapsedNodes.clear();
    render(ctx);
    setTimeout(() => fitToView(ctx), 50);
  });

  ctx.searchInput.addEventListener("input", () => {
    ctx.searchQuery = ctx.searchInput.value.toLowerCase().trim();
    applySearch(ctx);
  });

  // Don't trigger keyboard shortcuts while typing in search
  ctx.searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      ctx.searchInput.value = "";
      ctx.searchQuery = "";
      applySearch(ctx);
      ctx.searchInput.blur();
    }
  });

  // Follow button: hidden when monitor off, visible when monitor on
  if (ctx.btnFollow) {
    ctx.btnFollow.classList.add("hidden");
    ctx.btnFollow.addEventListener("click", () => {
      ctx.followMode = !ctx.followMode;
      ctx.btnFollow!.classList.toggle("active", ctx.followMode);
    });
  }

  // Layout toggle: auto -> horizontal -> waterfall -> auto
  if (ctx.btnLayoutToggle) {
    const updateLayoutLabel = () => {
      const labels = { auto: "Auto", horizontal: "Horizontal", waterfall: "Waterfall" };
      ctx.btnLayoutToggle!.textContent = "View: " + labels[ctx.layoutMode];
    };
    updateLayoutLabel();
    ctx.btnLayoutToggle.addEventListener("click", () => {
      if (ctx.layoutMode === "auto") ctx.layoutMode = "horizontal";
      else if (ctx.layoutMode === "horizontal") ctx.layoutMode = "waterfall";
      else ctx.layoutMode = "auto";
      updateLayoutLabel();
      render(ctx);
      reapplyStatusOverlay(ctx);
      setTimeout(() => fitToView(ctx), 50);
    });
  }

  // Expand All: show everything - clear collapses AND inline every SubTree.
  if (ctx.btnExpandAll) {
    ctx.btnExpandAll.addEventListener("click", () => {
      const tree = getActiveTree(ctx);
      if (!tree || !tree.root) return;
      ctx.collapsedNodes.clear();
      expandAllSubtrees(ctx, tree);
      render(ctx);
      reapplyStatusOverlay(ctx);
      setTimeout(() => fitToView(ctx), 50);
    });
  }

  // Reset: return to the clean Depth-N view, discarding manual expand/collapse
  // (both node collapses and SubTree inlines).
  if (ctx.btnCollapseAll) {
    ctx.btnCollapseAll.addEventListener("click", () => {
      const tree = getActiveTree(ctx);
      if (!tree || !tree.root) return;
      ctx.collapsedNodes.clear();
      ctx.expandedSubtrees.clear();
      autoCollapseDepth(ctx, tree.root, 0, ctx.autoCollapseLevel);
      render(ctx);
      reapplyStatusOverlay(ctx);
      setTimeout(() => fitToView(ctx), 50);
    });
  }

  // Depth: set the baseline collapse level and apply the clean Depth-N view.
  if (ctx.depthInput) {
    ctx.depthInput.addEventListener("change", () => {
      ctx.autoCollapseLevel = Math.max(1, Math.min(20, parseInt(ctx.depthInput!.value, 10) || 3));
      const tree = getActiveTree(ctx);
      if (!tree || !tree.root) return;
      ctx.collapsedNodes.clear();
      ctx.expandedSubtrees.clear();
      autoCollapseDepth(ctx, tree.root, 0, ctx.autoCollapseLevel);
      render(ctx);
      reapplyStatusOverlay(ctx);
      setTimeout(() => fitToView(ctx), 50);
    });
    ctx.depthInput.addEventListener("keydown", (e) => e.stopPropagation());
  }

  ctx.btnMonitor.addEventListener("click", () => {
    if (!ctx.monitorAvailable) return;
    if (ctx.monitorActive) {
      ctx.vscode.postMessage({ command: "stopMonitor" });
      ctx.monitorActive = false;
      ctx.btnMonitor.classList.remove("active");
      ctx.monitorStatusEl.textContent = "";
      clearMonitorOverlay(ctx);
      updateFollowButtonState(ctx);
    } else {
      ctx.monitorStatusEl.textContent = "connecting...";
      ctx.monitorActive = true; // Show follow button immediately
      updateFollowButtonState(ctx);
      ctx.vscode.postMessage({ command: "startMonitor" });
    }
  });
}
