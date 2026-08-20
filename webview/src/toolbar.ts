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
    if (tree.id === (ctx.view.selectedTreeId || ctx.treeData.mainTreeId)) opt.selected = true;
    ctx.treeSelector.appendChild(opt);
  }
}

export function applySearch(ctx: ViewerContext): void {
  let matchCount = 0;
  for (const node of ctx.scene.layoutNodes) {
    const el = ctx.scene.nodeElements.get(node.id);
    if (!el) continue;

    if (!ctx.view.searchQuery) {
      el.classList.remove("search-match", "search-dim");
      continue;
    }

    const text = (node.name + " " + node.type).toLowerCase();
    const portText = node.ports.map(p => p.name + " " + p.value).join(" ").toLowerCase();
    const isMatch = text.includes(ctx.view.searchQuery) || portText.includes(ctx.view.searchQuery);

    el.classList.toggle("search-match", isMatch);
    el.classList.toggle("search-dim", !isMatch);
    if (isMatch) matchCount++;
  }

  ctx.searchCount.textContent = ctx.view.searchQuery ? `${matchCount} found` : "";
}

/** Wire every toolbar control. Call once at startup. */
export function initToolbar(ctx: ViewerContext): void {
  ctx.btnFit.addEventListener("click", () => fitToView(ctx));
  ctx.btnZoomIn.addEventListener("click", () => {
    ctx.camera.zoom = Math.min(5, ctx.camera.zoom * 1.2);
    updateTransform(ctx);
  });
  ctx.btnZoomOut.addEventListener("click", () => {
    ctx.camera.zoom = Math.max(0.1, ctx.camera.zoom / 1.2);
    updateTransform(ctx);
  });
  if (ctx.btnExportPdf) {
    ctx.btnExportPdf.addEventListener("click", () => { void exportTreeToPdf(ctx); });
  }

  ctx.treeSelector.addEventListener("change", () => {
    ctx.view.selectedTreeId = ctx.treeSelector.value;
    ctx.view.collapsedNodes.clear();
    render(ctx);
    setTimeout(() => fitToView(ctx), 50);
  });

  ctx.searchInput.addEventListener("input", () => {
    ctx.view.searchQuery = ctx.searchInput.value.toLowerCase().trim();
    applySearch(ctx);
  });

  // Don't trigger keyboard shortcuts while typing in search
  ctx.searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      ctx.searchInput.value = "";
      ctx.view.searchQuery = "";
      applySearch(ctx);
      ctx.searchInput.blur();
    }
  });

  // Follow button: hidden when monitor off, visible when monitor on
  if (ctx.btnFollow) {
    ctx.btnFollow.classList.add("hidden");
    ctx.btnFollow.addEventListener("click", () => {
      ctx.view.followMode = !ctx.view.followMode;
      ctx.btnFollow!.classList.toggle("active", ctx.view.followMode);
    });
  }

  // Layout toggle: auto -> horizontal -> waterfall -> auto
  if (ctx.btnLayoutToggle) {
    const updateLayoutLabel = () => {
      const labels = { auto: "Auto", horizontal: "Horizontal", waterfall: "Waterfall" };
      ctx.btnLayoutToggle!.textContent = "View: " + labels[ctx.view.layoutMode];
    };
    updateLayoutLabel();
    ctx.btnLayoutToggle.addEventListener("click", () => {
      if (ctx.view.layoutMode === "auto") ctx.view.layoutMode = "horizontal";
      else if (ctx.view.layoutMode === "horizontal") ctx.view.layoutMode = "waterfall";
      else ctx.view.layoutMode = "auto";
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
      ctx.view.collapsedNodes.clear();
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
      ctx.view.collapsedNodes.clear();
      ctx.view.expandedSubtrees.clear();
      autoCollapseDepth(ctx, tree.root, 0, ctx.view.autoCollapseLevel);
      render(ctx);
      reapplyStatusOverlay(ctx);
      setTimeout(() => fitToView(ctx), 50);
    });
  }

  // Depth: set the baseline collapse level and apply the clean Depth-N view.
  if (ctx.depthInput) {
    ctx.depthInput.addEventListener("change", () => {
      ctx.view.autoCollapseLevel = Math.max(1, Math.min(20, parseInt(ctx.depthInput!.value, 10) || 3));
      const tree = getActiveTree(ctx);
      if (!tree || !tree.root) return;
      ctx.view.collapsedNodes.clear();
      ctx.view.expandedSubtrees.clear();
      autoCollapseDepth(ctx, tree.root, 0, ctx.view.autoCollapseLevel);
      render(ctx);
      reapplyStatusOverlay(ctx);
      setTimeout(() => fitToView(ctx), 50);
    });
    ctx.depthInput.addEventListener("keydown", (e) => e.stopPropagation());
  }

  ctx.btnMonitor.addEventListener("click", () => {
    if (!ctx.monitor.available) return;
    if (ctx.monitor.active) {
      ctx.vscode.postMessage({ command: "stopMonitor" });
      ctx.monitor.active = false;
      ctx.btnMonitor.classList.remove("active");
      ctx.monitorStatusEl.textContent = "";
      clearMonitorOverlay(ctx);
      updateFollowButtonState(ctx);
    } else {
      ctx.monitorStatusEl.textContent = "connecting...";
      ctx.monitor.active = true; // Show follow button immediately
      updateFollowButtonState(ctx);
      ctx.vscode.postMessage({ command: "startMonitor" });
    }
  });
}
