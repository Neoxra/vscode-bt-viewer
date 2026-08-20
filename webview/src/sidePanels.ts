/**
 * @fileoverview Side panel content: the blackboard variable viewer, the node
 * palette (with per-type descriptions), and the per-node detail panel.
 */

import { NodeCategory } from "../../shared/protocol";
import { MODIFIER_CLICK_LABEL } from "./constants";
import { BTNode, ViewerContext } from "./context";
import { escHtml, fitToView, hideTooltip } from "./interaction";
import { NODE_DESCRIPTIONS, getNodeDescription } from "./nodeDescriptions";
import { render } from "./render";

// ------ BLACKBOARD VIEWER ------

interface BlackboardVar {
  readers: Set<string>;
  writers: Set<string>;
}

function buildBlackboard(ctx: ViewerContext): Record<string, BlackboardVar> {
  if (!ctx.treeData || !ctx.treeData.trees) return {};
  const vars: Record<string, BlackboardVar> = {}; // varName -> { readers, writers }

  for (const tree of ctx.treeData.trees) {
    walkForBlackboard(tree.root, vars);
  }
  return vars;
}

function walkForBlackboard(node: BTNode | null, vars: Record<string, BlackboardVar>): void {
  if (!node) return;
  for (const port of (node.ports || [])) {
    // Detect {variable} references
    const matches = port.value.match(/\{(\w+)\}/g);
    if (matches) {
      for (const m of matches) {
        const varName = m.slice(1, -1);
        if (!vars[varName]) vars[varName] = { readers: new Set(), writers: new Set() };
        if (port.direction === "output" || port.direction === "inout") {
          vars[varName].writers.add(node.type + (node.name !== node.type ? ` (${node.name})` : ""));
        }
        if (port.direction === "input" || port.direction === "inout") {
          vars[varName].readers.add(node.type + (node.name !== node.type ? ` (${node.name})` : ""));
        }
      }
    }
  }
  for (const child of (node.children || [])) {
    walkForBlackboard(child, vars);
  }
}

export function showBlackboard(ctx: ViewerContext): void {
  const vars = buildBlackboard(ctx);
  const sorted = Object.keys(vars).sort();

  let html = "";
  if (sorted.length === 0) {
    html = '<div style="color:var(--vscode-descriptionForeground,#888);padding:10px">No blackboard variables found</div>';
  } else {
    for (const name of sorted) {
      const v = vars[name];
      html += `<div class="bb-var">`;
      html += `<div class="bb-var-name">{${escHtml(name)}}</div>`;
      if (v.writers.size > 0) {
        html += `<div class="bb-var-nodes">Write: ${[...v.writers].map(escHtml).join(", ")}</div>`;
      }
      if (v.readers.size > 0) {
        html += `<div class="bb-var-nodes">Read: ${[...v.readers].map(escHtml).join(", ")}</div>`;
      }
      html += `</div>`;
    }
  }

  ctx.sidePanelTitle.textContent = `Blackboard (${sorted.length} vars)`;
  ctx.sidePanelContent.innerHTML = html;
  ctx.sidePanel.classList.remove("hidden");
  ctx.view.activeSidePanel = "blackboard";
  ctx.btnBlackboard.classList.add("active");
  ctx.btnPalette.classList.remove("active");
  hideGotoButton(ctx);
}

// ------ NODE PALETTE ------

export function showPalette(ctx: ViewerContext): void {
  const models = (ctx.treeData && ctx.treeData.nodeModels) || [];
  const byCategory: Record<string, typeof models> = {};

  for (const model of models) {
    const cat = model.category || "action";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(model);
  }

  // Also gather node types actually used in the tree (in case no TreeNodesModel)
  const usedTypes = new Map<string, { category: string }>();
  if (ctx.treeData && ctx.treeData.trees) {
    for (const tree of ctx.treeData.trees) {
      walkForPalette(tree.root, usedTypes);
    }
  }

  let html = "";
  const categoryOrder: NodeCategory[] = ["control", "decorator", "action", "condition", "subtree", "script"];

  for (const cat of categoryOrder) {
    const catModels = byCategory[cat] || [];
    // Merge with used types not in models
    const modelTypes = new Set(catModels.map(m => m.type));
    for (const [type, info] of usedTypes) {
      if (info.category === cat && !modelTypes.has(type)) {
        catModels.push({ type, category: cat, ports: [] });
      }
    }

    if (catModels.length === 0) continue;

    const color = ctx.colors[cat] || { fill: "#555" };
    const catDesc = NODE_DESCRIPTIONS["_cat_" + cat];
    html += `<div class="palette-category">`;
    html += `<div class="palette-category-title">${cat} (${catModels.length})`;
    if (catDesc) {
      html += ` <span class="palette-help-btn" data-cat-desc="${cat}" title="What is a ${cat} node?">?</span>`;
    }
    html += `</div>`;
    if (catDesc) {
      html += `<div class="palette-cat-desc hidden" data-cat-desc-for="${cat}">${escHtml(catDesc)}</div>`;
    }

    for (const model of catModels.sort((a, b) => a.type.localeCompare(b.type))) {
      const desc = getNodeDescription(ctx, model.type);
      html += `<div class="palette-node" style="background:${color.fill}22;border-left:3px solid ${color.fill}">`;
      html += `<span>${escHtml(model.type)}</span>`;
      if (desc) {
        html += `<span class="palette-help-btn" data-desc-type="${escHtml(model.type)}" title="Show description">?</span>`;
      }
      html += `</div>`;
      html += `<div class="palette-node-desc hidden" data-desc-for="${escHtml(model.type)}">${desc ? escHtml(desc) : ""}</div>`;
      if (model.ports && model.ports.length > 0) {
        for (const p of model.ports) {
          const dir = p.direction === "input" ? "in" : p.direction === "output" ? "out" : "io";
          html += `<div class="palette-node-ports">[${dir}] ${escHtml(p.name)}${p.type ? ": " + escHtml(p.type) : ""}${p.default ? " = " + escHtml(p.default) : ""}</div>`;
        }
      }
    }
    html += `</div>`;
  }

  if (!html) {
    html = '<div style="color:var(--vscode-descriptionForeground,#888);padding:10px">No node models found in XML</div>';
  }

  ctx.sidePanelTitle.textContent = "Node Palette";
  ctx.sidePanelContent.innerHTML = html;
  ctx.sidePanel.classList.remove("hidden");
  ctx.view.activeSidePanel = "palette";
  ctx.btnPalette.classList.add("active");
  ctx.btnBlackboard.classList.remove("active");
  hideGotoButton(ctx);

  // Wire up help button toggles (node descriptions)
  ctx.sidePanelContent.querySelectorAll(".palette-help-btn[data-desc-type]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const type = btn.getAttribute("data-desc-type");
      const descEl = ctx.sidePanelContent.querySelector(`[data-desc-for="${type}"]`);
      if (descEl) descEl.classList.toggle("hidden");
    });
  });
  // Wire up category description toggles
  ctx.sidePanelContent.querySelectorAll(".palette-help-btn[data-cat-desc]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const cat = btn.getAttribute("data-cat-desc");
      const descEl = ctx.sidePanelContent.querySelector(`[data-cat-desc-for="${cat}"]`);
      if (descEl) descEl.classList.toggle("hidden");
    });
  });
}

function walkForPalette(node: BTNode | null, types: Map<string, { category: string }>): void {
  if (!node) return;
  if (!types.has(node.type)) {
    types.set(node.type, { category: node.category });
  }
  for (const child of (node.children || [])) {
    walkForPalette(child, types);
  }
}

export function closeSidePanel(ctx: ViewerContext): void {
  ctx.sidePanel.classList.add("hidden");
  ctx.view.activeSidePanel = null;
  ctx.btnBlackboard.classList.remove("active");
  ctx.btnPalette.classList.remove("active");
  if (ctx.sidePanelGoto) ctx.sidePanelGoto.classList.add("hidden");
}

function hideGotoButton(ctx: ViewerContext): void {
  if (ctx.sidePanelGoto) ctx.sidePanelGoto.classList.add("hidden");
}

/** Wire the Blackboard/Palette toggle buttons and the panel close button. */
export function initSidePanels(ctx: ViewerContext): void {
  ctx.btnBlackboard.addEventListener("click", () => {
    if (ctx.view.activeSidePanel === "blackboard") { closeSidePanel(ctx); return; }
    showBlackboard(ctx);
  });

  ctx.btnPalette.addEventListener("click", () => {
    if (ctx.view.activeSidePanel === "palette") { closeSidePanel(ctx); return; }
    showPalette(ctx);
  });

  ctx.sidePanelClose.addEventListener("click", () => closeSidePanel(ctx));
}

// ------ NODE DETAIL PANEL ------

export function showNodeDetail(ctx: ViewerContext, node: BTNode): void {
  hideTooltip(ctx);
  const desc = getNodeDescription(ctx, node.type);
  const cat = node.category || "action";
  const color = ctx.colors[cat] || { fill: "#555" };

  let html = "";
  html += `<div class="detail-header" style="border-left:4px solid ${color.fill};padding-left:8px;margin-bottom:10px">`;
  html += `<div class="detail-name">${escHtml(node.name)}</div>`;
  if (node.type !== node.name) {
    html += `<div class="detail-type">${escHtml(node.type)}</div>`;
  }
  html += `<div class="detail-category">${escHtml(cat)}</div>`;
  html += `</div>`;

  // SubTree: add button to view the referenced tree
  if (node.category === "subtree" && ctx.treeData && ctx.treeData.trees) {
    const subtreeName = node.ports.find(p => p.name === "ID");
    const treeName = subtreeName ? subtreeName.value : node.name;
    const subtree = ctx.treeData.trees.find(t => t.id === treeName);
    if (subtree) {
      html += `<div class="detail-section">`;
      html += `<button class="toolbar-btn" id="btn-view-subtree" data-tree-id="${escHtml(treeName)}" style="width:100%;margin-bottom:6px">View SubTree: ${escHtml(treeName)}</button>`;
      html += `</div>`;
    }
  }

  if (desc) {
    html += `<div class="detail-section">`;
    html += `<div class="detail-section-title">Description</div>`;
    html += `<div class="detail-desc">${escHtml(desc)}</div>`;
    html += `</div>`;
  }

  if (node.ports.length > 0) {
    html += `<div class="detail-section">`;
    html += `<div class="detail-section-title">Ports (${node.ports.length})</div>`;
    for (const port of node.ports) {
      const dirLabel = port.direction === "input" ? "IN" : port.direction === "output" ? "OUT" : "IO";
      const dirClass = port.direction === "output" ? "port-dir-out" : port.direction === "inout" ? "port-dir-io" : "port-dir-in";
      html += `<div class="detail-port">`;
      html += `<span class="detail-port-dir ${dirClass}">${dirLabel}</span> `;
      html += `<span class="port-name">${escHtml(port.name)}</span>`;
      html += `<div class="detail-port-value">${escHtml(port.value)}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Show port model info from TreeNodesModel if available
  if (ctx.treeData && ctx.treeData.nodeModels) {
    const model = ctx.treeData.nodeModels.find(m => m.type === node.type);
    if (model && model.ports && model.ports.length > 0) {
      html += `<div class="detail-section">`;
      html += `<div class="detail-section-title">Port Definitions</div>`;
      for (const p of model.ports) {
        const dir = p.direction === "input" ? "IN" : p.direction === "output" ? "OUT" : "IO";
        html += `<div class="detail-port">`;
        html += `<span class="detail-port-dir">${dir}</span> `;
        html += `<span class="port-name">${escHtml(p.name)}</span>`;
        if (p.type) html += ` <span class="detail-port-type">${escHtml(p.type)}</span>`;
        if (p.default) html += ` <span class="detail-port-default">= ${escHtml(p.default)}</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
  }

  if (node.children && node.children.length > 0) {
    html += `<div class="detail-section">`;
    html += `<div class="detail-section-title">Children (${node.children.length})</div>`;
    for (const child of node.children) {
      const cColor = ctx.colors[child.category] || { fill: "#555" };
      html += `<div class="detail-child" style="border-left:3px solid ${cColor.fill};padding-left:6px;margin:2px 0;cursor:pointer" data-child-id="${child.id}">`;
      html += `${escHtml(child.name)} <span class="detail-type">${escHtml(child.type)}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  ctx.sidePanelTitle.textContent = "Node Info";
  ctx.sidePanelContent.innerHTML = html;
  ctx.sidePanel.classList.remove("hidden");
  ctx.view.activeSidePanel = "detail";
  ctx.btnBlackboard.classList.remove("active");
  ctx.btnPalette.classList.remove("active");

  // Click on child to navigate
  ctx.sidePanelContent.querySelectorAll("[data-child-id]").forEach(el => {
    el.addEventListener("click", () => {
      const childId = el.getAttribute("data-child-id");
      const childNode = childId ? ctx.scene.nodeById.get(childId) : undefined;
      if (childNode) showNodeDetail(ctx, childNode);
    });
  });

  // Header "Go to" button: small mouse-only alternative to Ctrl/Cmd-click.
  // Only visible when the parser resolved a source line for this node.
  if (ctx.sidePanelGoto) {
    if (node.xmlLine) {
      const line = node.xmlLine;
      ctx.sidePanelGoto.title = `Go to source line ${line} (or ${MODIFIER_CLICK_LABEL} the node)`;
      ctx.sidePanelGoto.onclick = () => {
        ctx.vscode.postMessage({
          command: "goToLine",
          line,
          file: node._sourceFile,
        });
      };
      ctx.sidePanelGoto.classList.remove("hidden");
    } else {
      ctx.sidePanelGoto.classList.add("hidden");
      ctx.sidePanelGoto.onclick = null;
    }
  }

  // View SubTree button: switch main view to that tree
  const viewBtn = ctx.sidePanelContent.querySelector("#btn-view-subtree");
  if (viewBtn) {
    viewBtn.addEventListener("click", () => {
      const treeId = viewBtn.getAttribute("data-tree-id");
      if (treeId && ctx.treeSelector) {
        ctx.treeSelector.value = treeId;
        ctx.view.selectedTreeId = treeId;
        ctx.view.collapsedNodes.clear();
        render(ctx);
        setTimeout(() => fitToView(ctx), 50);
        closeSidePanel(ctx);
      }
    });
  }
}
