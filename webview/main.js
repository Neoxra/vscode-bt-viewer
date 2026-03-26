// @ts-check
/// <reference lib="dom" />

/**
 * BehaviorTree Viewer - Webview rendering engine
 * Renders BT.CPP v4 tree data as an interactive SVG diagram.
 * Nodes are individually draggable; edges update in real-time.
 */

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // Layout constants
  const NODE_H = 32;
  const NODE_MIN_W = 80;
  const NODE_PADDING_X = 12;
  const LEVEL_GAP = 50;
  const SIBLING_GAP = 12;
  const PORT_LINE_H = 12;
  const CHAR_WIDTH = 6.4;

  // State
  let treeData = null;
  let colors = {};
  let zoom = 1;
  let panX = 0;
  let panY = 40;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;

  // Dragging state
  let draggedNode = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  let collapsedNodes = new Set();
  let layoutNodes = [];
  let layoutEdges = [];

  // Maps for efficient lookups during drag
  let nodeElements = new Map();  // nodeId -> SVG <g> element
  let edgeElements = [];         // { path, sourceId, targetId }
  let nodeById = new Map();      // nodeId -> node data

  // DOM refs
  const svg = document.getElementById("tree-svg");
  const treeGroup = document.getElementById("tree-group");
  const edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  edgeGroup.setAttribute("id", "edge-group");
  nodeGroup.setAttribute("id", "node-group");
  treeGroup.appendChild(edgeGroup);
  treeGroup.appendChild(nodeGroup);

  const tooltip = document.getElementById("tooltip");
  const container = document.getElementById("canvas-container");
  const fileNameEl = document.getElementById("file-name");
  const zoomLevelEl = document.getElementById("zoom-level");
  const errorOverlay = document.getElementById("error-overlay");
  const errorMessage = document.getElementById("error-message");
  const btnFit = document.getElementById("btn-fit");
  const btnZoomIn = document.getElementById("btn-zoom-in");
  const btnZoomOut = document.getElementById("btn-zoom-out");
  const btnExpandSubtrees = document.getElementById("btn-expand-subtrees");
  const treeSelector = document.getElementById("tree-selector");
  const searchInput = document.getElementById("search-input");
  const searchCount = document.getElementById("search-count");
  const btnBlackboard = document.getElementById("btn-blackboard");
  const btnPalette = document.getElementById("btn-palette");
  const sidePanel = document.getElementById("side-panel");
  const sidePanelTitle = document.getElementById("side-panel-title");
  const sidePanelContent = document.getElementById("side-panel-content");
  const sidePanelClose = document.getElementById("side-panel-close");

  const btnLayoutToggle = document.getElementById("btn-layout-toggle");
  const btnExpandAll = document.getElementById("btn-expand-all");
  const btnCollapseAll = document.getElementById("btn-collapse-all");
  const btnMonitor = document.getElementById("btn-monitor");
  const btnFollow = document.getElementById("btn-follow");
  const depthInput = document.getElementById("depth-input");
  const monitorStatusEl = document.getElementById("monitor-status");
  let followMode = false;
  let autoCollapseLevel = 3;
  let layoutMode = "auto"; // "auto" | "horizontal" | "waterfall"
  const minimap = document.getElementById("minimap");
  const minimapCtx = minimap ? minimap.getContext("2d") : null;

  let selectedTreeId = null;
  let searchQuery = "";
  let activeSidePanel = null; // "blackboard" | "palette" | "detail" | "subtreeView" | null
  let monitorActive = false;
  let lastNodeStatuses = {}; // uid -> status string

  // ------ NODE DESCRIPTIONS ------

  const NODE_DESCRIPTIONS = {
    // Category descriptions (keyed by category name)
    _cat_control: "Control nodes define the flow of execution through the tree. They have one or more children and decide the order and conditions under which children are ticked.",
    _cat_decorator: "Decorator nodes have exactly one child and modify its behavior or result. They can repeat, retry, invert, force success/failure, or add timeouts.",
    _cat_action: "Action nodes are leaves that perform work: calling ROS services, publishing messages, running computations, or interacting with hardware. They return SUCCESS, FAILURE, or RUNNING.",
    _cat_condition: "Condition nodes are leaves that check a state without side effects. They return SUCCESS (true) or FAILURE (false) and never return RUNNING.",
    _cat_subtree: "SubTree nodes reference another BehaviorTree defined in the same file, enabling modular and reusable tree composition.",
    _cat_script: "Script nodes execute inline expressions to read/write blackboard variables. Useful for variable initialization and simple transformations.",

    // Control nodes
    Sequence: "Ticks children left-to-right. Succeeds only if ALL children succeed. Fails immediately when any child fails. Restarts from first child on next tick.",
    ReactiveSequence: "Like Sequence, but re-ticks all children from the beginning on every tick. Useful for condition-guarded sequences where conditions must remain true.",
    SequenceWithMemory: "Like Sequence, but remembers which child was running and resumes from there on the next tick instead of restarting from the first child.",
    SequenceStar: "Alias for SequenceWithMemory.",
    Fallback: "Ticks children left-to-right. Succeeds immediately when any child succeeds. Fails only if ALL children fail. Used for recovery/alternative strategies.",
    ReactiveFallback: "Like Fallback, but re-ticks all children from the beginning on every tick. Useful for priority-based decision making with reactive conditions.",
    FallbackStar: "Like Fallback but with memory: resumes from the last running child instead of restarting.",
    Parallel: "Ticks all children simultaneously. Success/failure thresholds configurable. Default: succeeds if all succeed, fails if one fails.",
    ParallelAll: "Ticks all children in parallel. Succeeds when ALL children succeed. Fails if any child fails.",
    ParallelNode: "Alias for Parallel.",
    IfThenElse: "Three children: condition, then-branch, else-branch. Ticks condition first, then ticks the appropriate branch.",
    WhileDoElse: "Three children: condition, while-body, else-body. Keeps ticking while-body as long as condition succeeds; switches to else-body when condition fails.",
    Switch2: "Evaluates a variable and ticks one of 2 children based on the value, plus a default child.",
    Switch3: "Evaluates a variable and ticks one of 3 children based on the value, plus a default child.",
    Switch4: "Evaluates a variable and ticks one of 4 children based on the value, plus a default child.",
    Switch5: "Evaluates a variable and ticks one of 5 children based on the value, plus a default child.",
    Switch6: "Evaluates a variable and ticks one of 6 children based on the value, plus a default child.",

    // Decorator nodes
    RetryUntilSuccessful: "Retries its child up to N times until it succeeds. Fails if all attempts fail. Set num_attempts=-1 for infinite retries.",
    Repeat: "Repeats its child N times. Fails immediately if the child fails. Set num_cycles=-1 for infinite repetition.",
    ForceSuccess: "Always returns SUCCESS regardless of the child's result. Useful for optional/best-effort actions.",
    ForceFailure: "Always returns FAILURE regardless of the child's result.",
    Inverter: "Inverts the child's result: SUCCESS becomes FAILURE and vice versa. RUNNING is passed through.",
    KeepRunningUntilFailure: "Returns RUNNING as long as the child returns SUCCESS. Only returns FAILURE when the child fails.",
    Delay: "Waits for delay_msec milliseconds before ticking its child. Returns RUNNING during the delay.",
    RunOnce: "Ticks its child only once. On subsequent ticks, returns the same result as the first execution.",
    Timeout: "Ticks its child but returns FAILURE if it does not complete within the timeout period.",
    Precondition: "Checks a scripted condition before ticking its child. If the condition fails, returns FAILURE/SKIPPED without ticking the child.",

    // Condition/leaf nodes
    ScriptCondition: "Evaluates a script expression and returns SUCCESS if true, FAILURE if false. Used for blackboard variable checks.",
    AlwaysSuccess: "Always returns SUCCESS. Used as a placeholder or no-op.",
    AlwaysFailure: "Always returns FAILURE. Used for testing or forcing failure paths.",

    // Script nodes
    Script: "Executes a script expression that can read/write blackboard variables. Always returns SUCCESS.",
    SetBlackboard: "Sets a blackboard variable to a specified value. Always returns SUCCESS.",

    // SubTree
    SubTree: "References another BehaviorTree defined in the same file. Ports can be remapped between parent and child blackboards.",
    SubTreePlus: "Extended SubTree with automatic port remapping via _autoremap attribute.",
  };

  /** Get description for a node type. Checks built-in descriptions, then TreeNodesModel, then returns null. */
  function getNodeDescription(nodeType) {
    if (NODE_DESCRIPTIONS[nodeType]) return NODE_DESCRIPTIONS[nodeType];
    // Check if TreeNodesModel has a description for custom nodes
    if (treeData && treeData.nodeModels) {
      const model = treeData.nodeModels.find(m => m.type === nodeType);
      if (model && model.description) return model.description;
    }
    return null;
  }

  // ------ LAYOUT ENGINE ------

  const LINE_H = 13; // Height per line of text
  const MAX_CHARS_PER_LINE = 22; // Wrap threshold

  /** Split text into wrapped lines. */
  function wrapText(str, maxChars) {
    if (!str || str.length <= maxChars) return [str || ""];
    const lines = [];
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
  function computeNodeLines(node) {
    const nameLines = wrapText(node.name, MAX_CHARS_PER_LINE);
    const typeLines = (node.type !== node.name) ? wrapText(node.type, MAX_CHARS_PER_LINE) : [];
    const portLines = node.ports.map(p => {
      const s = `${p.name}: ${p.value}`;
      return wrapText(s, MAX_CHARS_PER_LINE + 4); // ports use smaller font, allow more
    });
    node._nameLines = nameLines;
    node._typeLines = typeLines;
    node._portLines = portLines;
    return { nameLines, typeLines, portLines };
  }

  function nodeWidth(node) {
    if (!node._nameLines) computeNodeLines(node);
    let maxLen = 0;
    for (const l of node._nameLines) maxLen = Math.max(maxLen, l.length);
    for (const l of node._typeLines) maxLen = Math.max(maxLen, l.length * 0.85);
    for (const pl of node._portLines) {
      for (const l of pl) maxLen = Math.max(maxLen, l.length * 0.75);
    }
    return Math.max(NODE_MIN_W, maxLen * CHAR_WIDTH + NODE_PADDING_X * 2);
  }

  function nodeHeight(node) {
    if (!node._nameLines) computeNodeLines(node);
    const nameH = node._nameLines.length * LINE_H;
    const typeH = node._typeLines.length * LINE_H;
    let portH = 0;
    for (const pl of node._portLines) portH += pl.length * PORT_LINE_H;
    return 8 + nameH + typeH + portH + 4; // padding top + content + padding bottom
  }

  const WATERFALL_THRESHOLD = 20; // Subtrees with 20+ visible nodes use waterfall
  const STEM_GAP = 20; // Gap between left stem line and child nodes

  /** Count visible (non-collapsed) nodes in a subtree. Cached on node as _visCount. */
  function countVisibleNodes(node) {
    if (node._visCount !== undefined) return node._visCount;
    let count = 1;
    if (!collapsedNodes.has(node.id)) {
      for (const child of (node.children || [])) {
        count += countVisibleNodes(child);
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
  function measureSubtree(node) {
    const w = nodeWidth(node);
    const h = nodeHeight(node);
    node._w = w;
    node._h = h;
    const isCollapsed = collapsedNodes.has(node.id);
    const children = isCollapsed ? [] : (node.children || []);

    if (children.length === 0) {
      node._subtreeW = w;
      node._subtreeH = h;
      return;
    }

    for (const child of children) measureSubtree(child);

    // Decide layout: manual override or auto based on subtree size
    const subtreeSize = countVisibleNodes(node);
    const goVertical = layoutMode === "waterfall" ? (children.length > 1)
      : layoutMode === "horizontal" ? false
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

  function positionSubtree(node, offsetX, offsetY) {
    const isCollapsed = collapsedNodes.has(node.id);
    const children = isCollapsed ? [] : (node.children || []);

    if (node._vertical && children.length > 1) {
      // Waterfall: parent at top-left, children stacked to the right
      // Parent is left-aligned in its allocated space
      node._x = offsetX;
      node._y = offsetY;

      const childX = offsetX + STEM_GAP + SIBLING_GAP;
      let cy = offsetY + node._h + LEVEL_GAP;
      for (let i = 0; i < children.length; i++) {
        positionSubtree(children[i], childX, cy);
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
        positionSubtree(children[i], cx, childY);
        cx += children[i]._subtreeW + SIBLING_GAP;
      }
    }
  }

  /**
   * Auto-collapse nodes deeper than maxDepth.
   * Nodes at exactly maxDepth that have children get collapsed.
   */
  function autoCollapseDepth(node, depth, maxDepth) {
    if (!node.children || node.children.length === 0) return;
    if (depth >= maxDepth) {
      collapsedNodes.add(node.id);
      return;
    }
    for (const child of node.children) {
      autoCollapseDepth(child, depth + 1, maxDepth);
    }
  }

  /**
   * During follow mode: expand the path to running nodes, collapse inactive deep branches.
   * Returns true if this node or any descendant is running.
   */
  function expandRunningPath(node, statuses, depth) {
    if (!node.children || node.children.length === 0) {
      if (node.uid !== undefined && statuses[String(node.uid)] === "RUNNING") return true;
      return false;
    }

    let anyRunning = false;
    if (node.uid !== undefined && statuses[String(node.uid)] === "RUNNING") anyRunning = true;

    for (const child of node.children) {
      if (expandRunningPath(child, statuses, depth + 1)) {
        anyRunning = true;
      }
    }

    if (anyRunning) {
      // This node is on the running path: expand it
      collapsedNodes.delete(node.id);
    } else if (depth >= 3) {
      // Not on running path and deep enough: collapse
      collapsedNodes.add(node.id);
    }

    return anyRunning;
  }

  function layoutTree(node) {
    // Clear cached counts from previous layout
    function clearCache(n) {
      n._visCount = undefined;
      for (const c of (n.children || [])) clearCache(c);
    }
    clearCache(node);

    measureSubtree(node);
    positionSubtree(node, 0, 0);
  }

  function flattenTree(node, nodes, edges, parent) {
    nodes.push(node);
    if (parent) parentMap.set(node.id, parent);
    const isCollapsed = collapsedNodes.has(node.id);
    const children = isCollapsed ? [] : (node.children || []);

    for (const child of children) {
      edges.push({ sourceId: node.id, targetId: child.id, vertical: !!node._vertical });
      flattenTree(child, nodes, edges, node);
    }
  }

  // ------ EDGE PATH ------

  function edgePath(source, target, vertical) {
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

  function updateAllEdges() {
    for (const e of edgeElements) {
      const source = nodeById.get(e.sourceId);
      const target = nodeById.get(e.targetId);
      if (source && target) {
        e.path.setAttribute("d", edgePath(source, target, e.vertical));
      }
    }
  }

  // ------ RENDERING ------

  function render() {
    if (!treeData || !treeData.trees || treeData.trees.length === 0) return;

    const treeId = selectedTreeId || treeData.mainTreeId;
    const mainTree = treeData.trees.find(t => t.id === treeId) || treeData.trees[0];
    if (!mainTree || !mainTree.root) return;

    // When viewing a subtree (not the main tree), mark root as subtree category
    // so it keeps the purple color matching the SubTree reference node
    if (treeId !== treeData.mainTreeId && mainTree.root._origCategory === undefined) {
      mainTree.root._origCategory = mainTree.root.category;
      mainTree.root.category = "subtree";
    }

    // Layout
    layoutTree(mainTree.root);
    layoutNodes = [];
    layoutEdges = [];
    parentMap.clear();
    flattenTree(mainTree.root, layoutNodes, layoutEdges, null);

    // Build lookup
    nodeById.clear();
    for (const node of layoutNodes) {
      nodeById.set(node.id, node);
    }

    // Clear
    edgeGroup.innerHTML = "";
    nodeGroup.innerHTML = "";
    nodeElements.clear();
    edgeElements = [];

    // Render edges
    for (const edge of layoutEdges) {
      const source = nodeById.get(edge.sourceId);
      const target = nodeById.get(edge.targetId);
      if (!source || !target) continue;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "bt-edge");
      path.setAttribute("d", edgePath(source, target, edge.vertical));
      edgeGroup.appendChild(path);
      edgeElements.push({ path, sourceId: edge.sourceId, targetId: edge.targetId, vertical: edge.vertical });
    }

    // Render nodes
    for (const node of layoutNodes) {
      const g = createNodeElement(node);
      nodeGroup.appendChild(g);
      nodeElements.set(node.id, g);
    }

    // Add legend
    renderLegend();
    updateTransform();
  }

  function createNodeElement(node) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "bt-node");
    g.setAttribute("transform", `translate(${node._x}, ${node._y})`);
    g.dataset.nodeId = node.id;

    const cat = node.category || "action";
    const color = colors[cat] || { fill: "#555", stroke: "#444", text: "#fff" };

    // Node rectangle
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("width", String(node._w));
    rect.setAttribute("height", String(node._h));
    rect.setAttribute("fill", color.fill);
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

    // Collapse/expand chevron button
    if (node.children && node.children.length > 0) {
      const isCollapsed = collapsedNodes.has(node.id);

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
      chevron.textContent = isCollapsed ? "\u25B6" : "\u25BC";
      g.appendChild(chevron);

      // Click chevron to toggle collapse
      function toggleCollapse(ev) {
        ev.stopPropagation();
        const oldX = node._x;
        const oldY = node._y;
        if (collapsedNodes.has(node.id)) {
          collapsedNodes.delete(node.id);
        } else {
          collapsedNodes.add(node.id);
        }
        const savedZoom = zoom;
        render();
        const updatedNode = nodeById.get(node.id);
        if (updatedNode) {
          panX -= (updatedNode._x - oldX) * savedZoom;
          panY -= (updatedNode._y - oldY) * savedZoom;
        }
        zoom = savedZoom;
        updateTransform();
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
        badgeText.textContent = `+${node.children.length}`;
        g.appendChild(badgeText);
      }
    }

    // Hover tooltip
    g.addEventListener("mouseenter", (e) => showTooltip(e, node));
    g.addEventListener("mouseleave", hideTooltip);

    // Click: show node info. Drag: move node. We distinguish by tracking movement.
    let clickStartX = 0;
    let clickStartY = 0;
    let didDrag = false;

    g.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      clickStartX = e.clientX;
      clickStartY = e.clientY;
      didDrag = false;
      startNodeDrag(e, node);
    });

    g.addEventListener("click", (e) => {
      e.stopPropagation();
      const dist = Math.abs(e.clientX - clickStartX) + Math.abs(e.clientY - clickStartY);
      if (dist < 5) {
        showNodeDetail(node);
      }
    });


    return g;
  }

  function renderLegend() {
    const oldLegend = document.getElementById("legend");
    if (oldLegend) oldLegend.remove();

    const legend = document.createElement("div");
    legend.id = "legend";

    const categories = ["control", "decorator", "action", "condition", "subtree", "script"];
    for (const cat of categories) {
      const color = colors[cat];
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

    container.appendChild(legend);
  }

  // ------ NODE DRAGGING ------

  // Parent map: nodeId -> parent node (built during flattenTree)
  let parentMap = new Map();

  function startNodeDrag(e, node) {
    draggedNode = node;
    const svgPoint = screenToSvg(e.clientX, e.clientY);
    dragOffsetX = svgPoint.x - node._x;
    dragOffsetY = svgPoint.y - node._y;
    hideTooltip();

    const el = nodeElements.get(node.id);
    if (el) el.classList.add("dragging");
  }

  function handleNodeDrag(e) {
    if (!draggedNode) return;

    const svgPoint = screenToSvg(e.clientX, e.clientY);
    const newX = svgPoint.x - dragOffsetX;
    const newY = svgPoint.y - dragOffsetY;
    const dx = newX - draggedNode._x;
    const dy = newY - draggedNode._y;

    // Just move the subtree, no collision during drag
    moveSubtreeBy(draggedNode, dx, dy);
    updateAllNodePositions();
    updateAllEdges();
  }

  function endNodeDrag() {
    if (draggedNode) {
      const el = nodeElements.get(draggedNode.id);
      if (el) el.classList.remove("dragging");

      draggedNode = null;
      // On release: resolve all overlaps with animated settle
      animateSettle();
    }
  }

  /** Move a node and all its (non-collapsed) descendants by dx, dy. */
  function moveSubtreeBy(node, dx, dy) {
    node._x += dx;
    node._y += dy;
    const isCollapsed = collapsedNodes.has(node.id);
    if (!isCollapsed && node.children) {
      for (const child of node.children) {
        moveSubtreeBy(child, dx, dy);
      }
    }
  }

  /**
   * After mouse release, resolve all overlaps (including cascades),
   * then animate from current positions to final positions.
   */
  function animateSettle() {
    const gap = SIBLING_GAP;

    // 1. Snapshot current positions as animation start
    const startPos = new Map();
    for (const node of layoutNodes) {
      startPos.set(node.id, { x: node._x, y: node._y });
    }

    // 2. Iteratively resolve ALL overlaps (multi-pass, max 6 iterations)
    for (let pass = 0; pass < 6; pass++) {
      let anyPushed = false;

      for (let i = 0; i < layoutNodes.length; i++) {
        const a = layoutNodes[i];
        for (let j = i + 1; j < layoutNodes.length; j++) {
          const b = layoutNodes[j];

          const hOverlap = Math.min(a._x + a._w, b._x + b._w) - Math.max(a._x, b._x);
          const vOverlap = Math.min(a._y + a._h, b._y + b._h) - Math.max(a._y, b._y);
          if (hOverlap <= 0 || vOverlap <= 0) continue;

          // They overlap - push them apart horizontally
          const push = (hOverlap + gap) / 2;
          const aCx = a._x + a._w / 2;
          const bCx = b._x + b._w / 2;

          if (aCx <= bCx) {
            moveSubtreeBy(a, -push, 0);
            moveSubtreeBy(b, push, 0);
          } else {
            moveSubtreeBy(a, push, 0);
            moveSubtreeBy(b, -push, 0);
          }
          anyPushed = true;
        }
      }

      if (!anyPushed) break;
    }

    // 3. Record final positions
    const endPos = new Map();
    for (const node of layoutNodes) {
      endPos.set(node.id, { x: node._x, y: node._y });
    }

    // 4. Check if anything actually moved
    let anyMoved = false;
    for (const node of layoutNodes) {
      const s = startPos.get(node.id);
      const e = endPos.get(node.id);
      if (Math.abs(s.x - e.x) > 0.5 || Math.abs(s.y - e.y) > 0.5) {
        anyMoved = true;
        break;
      }
    }
    if (!anyMoved) return;

    // 5. Reset to start positions, then animate to end
    for (const node of layoutNodes) {
      const s = startPos.get(node.id);
      node._x = s.x;
      node._y = s.y;
    }

    const duration = 250;
    const startTime = performance.now();

    function tick(now) {
      const t = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic

      for (const node of layoutNodes) {
        const s = startPos.get(node.id);
        const e = endPos.get(node.id);
        node._x = s.x + (e.x - s.x) * ease;
        node._y = s.y + (e.y - s.y) * ease;
      }

      updateAllNodePositions();
      updateAllEdges();

      if (t < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  /** Sync all node DOM elements to their current _x, _y positions. */
  function updateAllNodePositions() {
    for (const node of layoutNodes) {
      const el = nodeElements.get(node.id);
      if (el) {
        el.setAttribute("transform", `translate(${node._x}, ${node._y})`);
      }
    }
  }

  /** Convert screen coordinates to SVG/tree coordinate space. */
  function screenToSvg(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    return {
      x: (clientX - rect.left - panX) / zoom,
      y: (clientY - rect.top - panY) / zoom,
    };
  }

  // ------ TOOLTIP ------

  function showTooltip(event, node) {
    if (draggedNode) return; // No tooltip while dragging

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

    tooltip.innerHTML = html;
    tooltip.classList.remove("hidden");

    const x = event.clientX + 12;
    const y = event.clientY + 12;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";

    const rect = tooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      tooltip.style.left = (event.clientX - rect.width - 12) + "px";
    }
    if (rect.bottom > window.innerHeight) {
      tooltip.style.top = (event.clientY - rect.height - 12) + "px";
    }
  }

  function hideTooltip() {
    tooltip.classList.add("hidden");
  }

  function escHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  // ------ PAN & ZOOM ------

  // Background pan: mousedown on SVG background
  container.addEventListener("mousedown", (e) => {
    // Only start pan if clicking on background (not a node)
    if (draggedNode) return;
    isPanning = true;
    panStartX = e.clientX - panX;
    panStartY = e.clientY - panY;
    container.classList.add("dragging");
  });

  window.addEventListener("mousemove", (e) => {
    if (draggedNode) {
      handleNodeDrag(e);
      return;
    }
    if (isPanning) {
      panX = e.clientX - panStartX;
      panY = e.clientY - panStartY;
      updateTransform();
    }
    // Update tooltip position
    if (!tooltip.classList.contains("hidden")) {
      tooltip.style.left = (e.clientX + 12) + "px";
      tooltip.style.top = (e.clientY + 12) + "px";
    }
  });

  window.addEventListener("mouseup", () => {
    if (draggedNode) {
      endNodeDrag();
    }
    isPanning = false;
    container.classList.remove("dragging");
  });

  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const prevZoom = zoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    zoom = Math.max(0.1, Math.min(5, zoom * delta));

    panX = mouseX - (mouseX - panX) * (zoom / prevZoom);
    panY = mouseY - (mouseY - panY) * (zoom / prevZoom);

    updateTransform();
  }, { passive: false });

  function updateTransform() {
    treeGroup.setAttribute("transform", `translate(${panX}, ${panY}) scale(${zoom})`);
    zoomLevelEl.textContent = Math.round(zoom * 100) + "%";
    drawMinimap();
  }

  // ------ MINIMAP ------

  function getTreeBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of layoutNodes) {
      minX = Math.min(minX, node._x);
      minY = Math.min(minY, node._y);
      maxX = Math.max(maxX, node._x + node._w);
      maxY = Math.max(maxY, node._y + node._h);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function drawMinimap() {
    if (!minimapCtx || layoutNodes.length === 0) { if (minimap) minimap.style.display = "none"; return; }
    const canvas = minimap;
    const cw = canvas.width;
    const ch = canvas.height;
    const ctx = minimapCtx;

    // Hide minimap if entire tree fits on screen
    const bounds = getTreeBounds();
    const containerRect = container.getBoundingClientRect();
    const viewL = -panX / zoom;
    const viewT = -panY / zoom;
    const viewR = viewL + containerRect.width / zoom;
    const viewB = viewT + containerRect.height / zoom;
    const allVisible = bounds.minX >= viewL && bounds.maxX <= viewR && bounds.minY >= viewT && bounds.maxY <= viewB;
    canvas.style.display = allVisible ? "none" : "block";
    if (allVisible) return;

    ctx.clearRect(0, 0, cw, ch);
    if (bounds.w <= 0 || bounds.h <= 0) return;

    // Scale tree to fit minimap with padding
    const pad = 6;
    const scaleX = (cw - pad * 2) / bounds.w;
    const scaleY = (ch - pad * 2) / bounds.h;
    const scale = Math.min(scaleX, scaleY);

    const ox = pad + (cw - pad * 2 - bounds.w * scale) / 2 - bounds.minX * scale;
    const oy = pad + (ch - pad * 2 - bounds.h * scale) / 2 - bounds.minY * scale;

    // Draw edges
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 0.5;
    for (const e of edgeElements) {
      const src = nodeById.get(e.sourceId);
      const tgt = nodeById.get(e.targetId);
      if (!src || !tgt) continue;
      ctx.beginPath();
      ctx.moveTo(ox + (src._x + src._w / 2) * scale, oy + (src._y + src._h) * scale);
      ctx.lineTo(ox + (tgt._x + tgt._w / 2) * scale, oy + tgt._y * scale);
      ctx.stroke();
    }

    // Draw nodes as small colored rectangles
    for (const node of layoutNodes) {
      const cat = node.category || "action";
      const color = colors[cat] || { fill: "#555" };

      const nx = ox + node._x * scale;
      const ny = oy + node._y * scale;
      const nw = Math.max(node._w * scale, 2);
      const nh = Math.max(node._h * scale, 1.5);

      // Highlight running nodes
      const el = nodeElements.get(node.id);
      if (el && el.classList.contains("status-running")) {
        ctx.fillStyle = "#00bfff";
      } else if (el && el.classList.contains("status-success")) {
        ctx.fillStyle = "#00ff88";
      } else if (el && el.classList.contains("status-failure")) {
        ctx.fillStyle = "#ff4444";
      } else {
        ctx.fillStyle = color.fill;
      }
      ctx.fillRect(nx, ny, nw, nh);
    }

    // Draw viewport rectangle (reuse containerRect from above)
    const vx = ox + (-panX / zoom) * scale;
    const vy = oy + (-panY / zoom) * scale;
    const vw = (containerRect.width / zoom) * scale;
    const vh = (containerRect.height / zoom) * scale;

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, vw, vh);
  }

  // Click on minimap to navigate
  if (minimap) {
    let minimapDragging = false;

    function minimapNavigate(e) {
      if (layoutNodes.length === 0) return;
      const rect = minimap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const bounds = getTreeBounds();
      if (bounds.w <= 0 || bounds.h <= 0) return;

      const cw = minimap.width;
      const ch = minimap.height;
      const pad = 6;
      const scaleX = (cw - pad * 2) / bounds.w;
      const scaleY = (ch - pad * 2) / bounds.h;
      const scale = Math.min(scaleX, scaleY);
      const ox = pad + (cw - pad * 2 - bounds.w * scale) / 2 - bounds.minX * scale;
      const oy = pad + (ch - pad * 2 - bounds.h * scale) / 2 - bounds.minY * scale;

      const containerRect = container.getBoundingClientRect();
      const treeX = (mx - ox) / scale;
      const treeY = (my - oy) / scale;

      panX = -treeX * zoom + containerRect.width / 2;
      panY = -treeY * zoom + containerRect.height / 2;
      updateTransform();
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

  function fitToView() {
    if (layoutNodes.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of layoutNodes) {
      minX = Math.min(minX, node._x);
      minY = Math.min(minY, node._y);
      maxX = Math.max(maxX, node._x + node._w);
      maxY = Math.max(maxY, node._y + node._h);
    }

    const treeW = maxX - minX || 1;
    const treeH = maxY - minY || 1;
    const containerRect = container.getBoundingClientRect();

    if (containerRect.width < 10 || containerRect.height < 10) {
      setTimeout(fitToView, 100);
      return;
    }

    const padX = 40;
    const padY = 50;

    const scaleX = (containerRect.width - padX * 2) / treeW;
    const scaleY = (containerRect.height - padY * 2) / treeH;
    zoom = Math.min(scaleX, scaleY, 1.5);
    zoom = Math.max(zoom, 0.15);

    panX = (containerRect.width - treeW * zoom) / 2 - minX * zoom;
    panY = padY - minY * zoom;

    updateTransform();
  }

  // Toolbar buttons
  btnFit.addEventListener("click", fitToView);
  btnZoomIn.addEventListener("click", () => {
    zoom = Math.min(5, zoom * 1.2);
    updateTransform();
  });
  btnZoomOut.addEventListener("click", () => {
    zoom = Math.max(0.1, zoom / 1.2);
    updateTransform();
  });
  btnExpandSubtrees.addEventListener("click", () => {
    btnExpandSubtrees.classList.toggle("active");
    vscode.postMessage({ command: "toggleSubtrees" });
  });

  // ------ TREE SELECTOR ------

  treeSelector.addEventListener("change", () => {
    selectedTreeId = treeSelector.value;
    collapsedNodes.clear();
    render();
    setTimeout(fitToView, 50);
  });

  function populateTreeSelector() {
    treeSelector.innerHTML = "";
    if (!treeData || !treeData.trees) return;
    for (const tree of treeData.trees) {
      const opt = document.createElement("option");
      opt.value = tree.id;
      opt.textContent = tree.id;
      if (tree.id === (selectedTreeId || treeData.mainTreeId)) opt.selected = true;
      treeSelector.appendChild(opt);
    }
  }

  // ------ SEARCH ------

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.toLowerCase().trim();
    applySearch();
  });

  // Don't trigger keyboard shortcuts while typing in search
  searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      searchInput.value = "";
      searchQuery = "";
      applySearch();
      searchInput.blur();
    }
  });

  function applySearch() {
    let matchCount = 0;
    for (const node of layoutNodes) {
      const el = nodeElements.get(node.id);
      if (!el) continue;

      if (!searchQuery) {
        el.classList.remove("search-match", "search-dim");
        continue;
      }

      const text = (node.name + " " + node.type).toLowerCase();
      const portText = node.ports.map(p => p.name + " " + p.value).join(" ").toLowerCase();
      const isMatch = text.includes(searchQuery) || portText.includes(searchQuery);

      el.classList.toggle("search-match", isMatch);
      el.classList.toggle("search-dim", !isMatch);
      if (isMatch) matchCount++;
    }

    searchCount.textContent = searchQuery ? `${matchCount} found` : "";
  }

  // ------ BLACKBOARD VIEWER ------

  function buildBlackboard() {
    if (!treeData || !treeData.trees) return {};
    const vars = {}; // varName -> { readers: Set, writers: Set }

    for (const tree of treeData.trees) {
      walkForBlackboard(tree.root, vars);
    }
    return vars;
  }

  function walkForBlackboard(node, vars) {
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

  function showBlackboard() {
    const vars = buildBlackboard();
    const sorted = Object.keys(vars).sort();

    let html = "";
    if (sorted.length === 0) {
      html = '<div style="color:#888;padding:10px">No blackboard variables found</div>';
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

    sidePanelTitle.textContent = `Blackboard (${sorted.length} vars)`;
    sidePanelContent.innerHTML = html;
    sidePanel.classList.remove("hidden");
    activeSidePanel = "blackboard";
    btnBlackboard.classList.add("active");
    btnPalette.classList.remove("active");
  }

  // ------ NODE PALETTE ------

  function showPalette() {
    const models = (treeData && treeData.nodeModels) || [];
    const byCategory = {};

    for (const model of models) {
      const cat = model.category || "action";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(model);
    }

    // Also gather node types actually used in the tree (in case no TreeNodesModel)
    const usedTypes = new Map();
    if (treeData && treeData.trees) {
      for (const tree of treeData.trees) {
        walkForPalette(tree.root, usedTypes);
      }
    }

    let html = "";
    const categoryOrder = ["control", "decorator", "action", "condition", "subtree", "script"];

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

      const color = colors[cat] || { fill: "#555" };
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
        const desc = getNodeDescription(model.type);
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
      html = '<div style="color:#888;padding:10px">No node models found in XML</div>';
    }

    sidePanelTitle.textContent = "Node Palette";
    sidePanelContent.innerHTML = html;
    sidePanel.classList.remove("hidden");
    activeSidePanel = "palette";
    btnPalette.classList.add("active");
    btnBlackboard.classList.remove("active");

    // Wire up help button toggles (node descriptions)
    sidePanelContent.querySelectorAll(".palette-help-btn[data-desc-type]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const type = btn.getAttribute("data-desc-type");
        const descEl = sidePanelContent.querySelector(`[data-desc-for="${type}"]`);
        if (descEl) descEl.classList.toggle("hidden");
      });
    });
    // Wire up category description toggles
    sidePanelContent.querySelectorAll(".palette-help-btn[data-cat-desc]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const cat = btn.getAttribute("data-cat-desc");
        const descEl = sidePanelContent.querySelector(`[data-cat-desc-for="${cat}"]`);
        if (descEl) descEl.classList.toggle("hidden");
      });
    });
  }

  function walkForPalette(node, types) {
    if (!node) return;
    if (!types.has(node.type)) {
      types.set(node.type, { category: node.category });
    }
    for (const child of (node.children || [])) {
      walkForPalette(child, types);
    }
  }

  function closeSidePanel() {
    sidePanel.classList.add("hidden");
    activeSidePanel = null;
    btnBlackboard.classList.remove("active");
    btnPalette.classList.remove("active");
  }

  // Side panel buttons
  btnBlackboard.addEventListener("click", () => {
    if (activeSidePanel === "blackboard") { closeSidePanel(); return; }
    showBlackboard();
  });

  btnPalette.addEventListener("click", () => {
    if (activeSidePanel === "palette") { closeSidePanel(); return; }
    showPalette();
  });

  sidePanelClose.addEventListener("click", closeSidePanel);

  // ------ NODE DETAIL PANEL ------

  function showNodeDetail(node) {
    hideTooltip();
    const desc = getNodeDescription(node.type);
    const cat = node.category || "action";
    const color = colors[cat] || { fill: "#555" };

    let html = "";
    html += `<div class="detail-header" style="border-left:4px solid ${color.fill};padding-left:8px;margin-bottom:10px">`;
    html += `<div class="detail-name">${escHtml(node.name)}</div>`;
    if (node.type !== node.name) {
      html += `<div class="detail-type">${escHtml(node.type)}</div>`;
    }
    html += `<div class="detail-category">${escHtml(cat)}</div>`;
    html += `</div>`;

    // SubTree: add button to view the referenced tree
    if (node.category === "subtree" && treeData && treeData.trees) {
      const subtreeName = node.ports.find(p => p.name === "ID");
      const treeName = subtreeName ? subtreeName.value : node.name;
      const subtree = treeData.trees.find(t => t.id === treeName);
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
    if (treeData && treeData.nodeModels) {
      const model = treeData.nodeModels.find(m => m.type === node.type);
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
        const cColor = colors[child.category] || { fill: "#555" };
        html += `<div class="detail-child" style="border-left:3px solid ${cColor.fill};padding-left:6px;margin:2px 0;cursor:pointer" data-child-id="${child.id}">`;
        html += `${escHtml(child.name)} <span class="detail-type">${escHtml(child.type)}</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }

    sidePanelTitle.textContent = "Node Info";
    sidePanelContent.innerHTML = html;
    sidePanel.classList.remove("hidden");
    activeSidePanel = "detail";
    btnBlackboard.classList.remove("active");
    btnPalette.classList.remove("active");

    // Click on child to navigate
    sidePanelContent.querySelectorAll("[data-child-id]").forEach(el => {
      el.addEventListener("click", () => {
        const childId = el.getAttribute("data-child-id");
        const childNode = nodeById.get(childId);
        if (childNode) showNodeDetail(childNode);
      });
    });

    // View SubTree button: switch main view to that tree
    const viewBtn = sidePanelContent.querySelector("#btn-view-subtree");
    if (viewBtn) {
      viewBtn.addEventListener("click", () => {
        const treeId = viewBtn.getAttribute("data-tree-id");
        if (treeId && treeSelector) {
          treeSelector.value = treeId;
          selectedTreeId = treeId;
          collapsedNodes.clear();
          render();
          setTimeout(fitToView, 50);
          closeSidePanel();
        }
      });
    }
  }

  // ------ LIVE MONITOR ------

  // Follow button: hidden when monitor off, visible when monitor on
  if (btnFollow) {
    btnFollow.classList.add("hidden");
    btnFollow.addEventListener("click", () => {
      followMode = !followMode;
      btnFollow.classList.toggle("active", followMode);
    });
  }

  function updateFollowButtonState() {
    if (!btnFollow) return;
    if (monitorActive) {
      btnFollow.classList.remove("hidden");
    } else {
      btnFollow.classList.add("hidden");
      followMode = false;
      btnFollow.classList.remove("active");
    }
  }

  // Layout toggle: auto -> horizontal -> waterfall -> auto
  if (btnLayoutToggle) {
    function updateLayoutLabel() {
      const labels = { auto: "Auto", horizontal: "Horizontal", waterfall: "Waterfall" };
      btnLayoutToggle.textContent = labels[layoutMode];
    }
    updateLayoutLabel();
    btnLayoutToggle.addEventListener("click", () => {
      if (layoutMode === "auto") layoutMode = "horizontal";
      else if (layoutMode === "horizontal") layoutMode = "waterfall";
      else layoutMode = "auto";
      updateLayoutLabel();
      render();
      setTimeout(fitToView, 50);
    });
  }

  // Expand/Collapse all
  if (btnExpandAll) {
    btnExpandAll.addEventListener("click", () => {
      collapsedNodes.clear();
      render();
      setTimeout(fitToView, 50);
    });
  }
  if (btnCollapseAll) {
    btnCollapseAll.addEventListener("click", () => {
      collapsedNodes.clear();
      if (treeData && treeData.trees) {
        const treeId = selectedTreeId || treeData.mainTreeId;
        const tree = treeData.trees.find(t => t.id === treeId) || treeData.trees[0];
        if (tree && tree.root) {
          autoCollapseDepth(tree.root, 0, autoCollapseLevel);
        }
      }
      render();
      setTimeout(fitToView, 50);
    });
  }

  // Depth input
  if (depthInput) {
    depthInput.addEventListener("change", () => {
      autoCollapseLevel = Math.max(1, Math.min(20, parseInt(depthInput.value, 10) || 3));
      // Re-apply collapse and re-render
      if (treeData && treeData.trees) {
        const treeId = selectedTreeId || treeData.mainTreeId;
        const tree = treeData.trees.find(t => t.id === treeId) || treeData.trees[0];
        if (tree && tree.root) {
          collapsedNodes.clear();
          autoCollapseDepth(tree.root, 0, autoCollapseLevel);
          render();
          setTimeout(fitToView, 50);
        }
      }
    });
    depthInput.addEventListener("keydown", (e) => e.stopPropagation());
  }

  btnMonitor.addEventListener("click", () => {
    if (monitorActive) {
      vscode.postMessage({ command: "stopMonitor" });
      monitorActive = false;
      btnMonitor.classList.remove("active");
      monitorStatusEl.textContent = "";
      clearMonitorOverlay();
      updateFollowButtonState();
    } else {
      monitorStatusEl.textContent = "connecting...";
      monitorActive = true; // Show follow button immediately
      updateFollowButtonState();
      vscode.postMessage({ command: "startMonitor" });
    }
  });

  let idleFadeTimer = null;

  function applyMonitorStatus(statuses) {
    lastNodeStatuses = statuses;

    // Empty statuses = server disconnected (BT finished)
    if (Object.keys(statuses).length === 0) {
      fadeMonitorOverlay();
      return;
    }

    // Check if everything is idle
    const runningUids = new Set();
    let allIdle = true;
    for (const [uid, status] of Object.entries(statuses)) {
      if (status === "RUNNING") runningUids.add(uid);
      if (status !== "IDLE") allIdle = false;
    }

    // If all nodes are idle, start a fade timer
    if (allIdle) {
      if (!idleFadeTimer) {
        idleFadeTimer = setTimeout(() => {
          fadeMonitorOverlay();
          idleFadeTimer = null;
        }, 1500); // Fade after 1.5s of continuous idle
      }
    } else {
      // Active nodes: cancel any pending fade
      if (idleFadeTimer) {
        clearTimeout(idleFadeTimer);
        idleFadeTimer = null;
      }
      // Remove fade class if it was applied
      const svgEl = document.getElementById("tree-group");
      if (svgEl) svgEl.classList.remove("monitor-faded");
    }

    for (const node of layoutNodes) {
      const el = nodeElements.get(node.id);
      if (!el) continue;

      el.classList.remove("status-idle", "status-running", "status-success", "status-failure", "subtree-active");

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

    drawMinimap();

    if (followMode) {
      // Auto-expand running path, collapse inactive deep branches
      if (treeData && treeData.trees) {
        const treeId = selectedTreeId || treeData.mainTreeId;
        const tree = treeData.trees.find(t => t.id === treeId) || treeData.trees[0];
        if (tree && tree.root) {
          const changed = expandRunningPath(tree.root, statuses, 0);
          if (changed) {
            const savedPanX = panX;
            const savedPanY = panY;
            const savedZoom = zoom;
            render();
            panX = savedPanX;
            panY = savedPanY;
            zoom = savedZoom;
            // Re-apply statuses after re-render
            for (const node of layoutNodes) {
              const el = nodeElements.get(node.id);
              if (!el || node.uid === undefined) continue;
              el.classList.remove("status-idle", "status-running", "status-success", "status-failure", "subtree-active");
              const st = statuses[String(node.uid)];
              if (st) el.classList.add("status-" + st.toLowerCase());
            }
          }
        }
      }
      zoomToRunning(statuses);
    }
  }

  function fadeMonitorOverlay() {
    const svgEl = document.getElementById("tree-group");
    if (svgEl) svgEl.classList.add("monitor-faded");
  }

  /** Find the deepest (highest UID) running leaf node and pan/zoom to it. */
  function zoomToRunning(statuses) {
    let target = null;
    let deepestY = -Infinity;

    for (const node of layoutNodes) {
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

    const containerRect = container.getBoundingClientRect();
    // Keep zoomed out enough to see context around the active node
    const targetZoom = Math.min(Math.max(zoom, 0.4), 0.7);
    const targetPanX = -target._x * targetZoom + containerRect.width / 2 - (target._w * targetZoom) / 2;
    const targetPanY = -target._y * targetZoom + containerRect.height / 2 - (target._h * targetZoom) / 2;

    // Smooth follow
    panX += (targetPanX - panX) * 0.2;
    panY += (targetPanY - panY) * 0.2;
    zoom += (targetZoom - zoom) * 0.15;
    updateTransform();
  }

  function clearMonitorOverlay() {
    lastNodeStatuses = {};
    if (idleFadeTimer) { clearTimeout(idleFadeTimer); idleFadeTimer = null; }
    const svgEl = document.getElementById("tree-group");
    if (svgEl) svgEl.classList.remove("monitor-faded");
    for (const node of layoutNodes) {
      const el = nodeElements.get(node.id);
      if (!el) continue;
      el.classList.remove("status-idle", "status-running", "status-success", "status-failure", "subtree-active");
    }
    drawMinimap();
  }

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") fitToView();
    if (e.key === "+" || e.key === "=") { zoom = Math.min(5, zoom * 1.2); updateTransform(); }
    if (e.key === "-") { zoom = Math.max(0.1, zoom / 1.2); updateTransform(); }
    if (e.key === "0") { zoom = 1; updateTransform(); }
    if (e.key === "r" || e.key === "R") { render(); setTimeout(fitToView, 50); }
    // Ctrl+F to focus search
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // ------ MESSAGE HANDLER ------

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.command) {
      case "updateTree":
        treeData = msg.data;
        colors = msg.colors || {};
        fileNameEl.textContent = msg.fileName || "Behavior Tree";
        errorOverlay.classList.add("hidden");
        collapsedNodes.clear();
        selectedTreeId = null;
        populateTreeSelector();
        // Auto-collapse deep branches for large trees
        if (treeData && treeData.trees) {
          const treeId = selectedTreeId || treeData.mainTreeId;
          const tree = treeData.trees.find(t => t.id === treeId) || treeData.trees[0];
          if (tree && tree.root) {
            const total = countVisibleNodes(tree.root);
            if (total > 30) {
              autoCollapseDepth(tree.root, 0, autoCollapseLevel);
            }
          }
        }
        render();
        setTimeout(fitToView, 150);
        // Refresh side panel if open
        if (activeSidePanel === "blackboard") showBlackboard();
        if (activeSidePanel === "palette") showPalette();
        break;

      case "error":
        errorOverlay.classList.remove("hidden");
        errorMessage.textContent = msg.message;
        break;

      case "monitorStatus":
        applyMonitorStatus(msg.nodes || {});
        break;

      case "monitorInfo":
        monitorStatusEl.textContent = msg.message;
        break;

      case "monitorError":
        monitorStatusEl.textContent = msg.message;
        monitorStatusEl.style.color = "var(--vscode-errorForeground, #f44)";
        setTimeout(() => { monitorStatusEl.style.color = ""; }, 3000);
        break;

      case "monitorConnected":
        monitorActive = true;
        btnMonitor.classList.add("active");
        updateFollowButtonState();
        break;

      case "monitorStopped":
        monitorActive = false;
        btnMonitor.classList.remove("active");
        monitorStatusEl.textContent = "";
        clearMonitorOverlay();
        updateFollowButtonState();
        break;
    }
  });

  // Re-layout and fit on window resize
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (treeData) {
        render();
        fitToView();
      }
    }, 100);
  });
})();
