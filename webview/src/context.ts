/**
 * @fileoverview Shared viewer context: the tree/view state and DOM references
 * every module operates on, grouped by ownership (camera, view, scene, drag,
 * monitor). Created once by main.ts and passed explicitly to every function
 * that needs it; no module holds state of its own.
 */

import {
  BTNodeData,
  BTParsedFile,
  BTTreeData,
  StatusMap,
  WebviewToHostMessage,
} from "../../shared/protocol";

/** Message channel back to the extension host. */
export interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * A tree node as parsed by the host, plus the layout fields the viewer adds.
 * Parser payloads arrive over postMessage and are cast to this type; the
 * underscore fields are assigned by computeNodeLines()/layoutTree() before
 * any consumer reads them (same invariant the pre-TypeScript code relied on).
 */
export interface BTNode extends BTNodeData {
  children: BTNode[];

  // Wrapped text lines, computed by computeNodeLines().
  _nameLines: string[];
  _typeLines: string[];
  _portLines: string[][];

  // Geometry, assigned by measureSubtree()/positionSubtree().
  _x: number;
  _y: number;
  _w: number;
  _h: number;
  _subtreeW: number;
  _subtreeH: number;
  _vertical?: boolean;
  _visCount?: number;

  // Set by buildLayoutTree() on layout-tree copies.
  _origId?: string;
  _sourceFile?: string;
  _origCategory?: string;
}

export interface Tree extends BTTreeData {
  root: BTNode;
}

export interface TreeData extends BTParsedFile {
  trees: Tree[];
}

export interface LayoutEdge {
  sourceId: string;
  targetId: string;
  vertical: boolean;
}

export interface EdgeElement extends LayoutEdge {
  path: SVGPathElement;
}

export type LayoutMode = "auto" | "horizontal" | "waterfall";
export type SidePanelKind = "blackboard" | "palette" | "detail" | "subtreeView" | null;

/** Pan/zoom of the tree canvas, including an in-progress background pan. */
export interface CameraState {
  zoom: number;
  panX: number;
  panY: number;
  isPanning: boolean;
  panStartX: number;
  panStartY: number;
}

/** An in-progress node drag (null node = not dragging). */
export interface DragState {
  node: BTNode | null;
  offsetX: number;
  offsetY: number;
}

/** What the user chose to look at: collapse/expand, layout, search, panels. */
export interface ViewState {
  collapsedNodes: Set<string>;
  // Per-node SubTree expansion. Keys are *layout* node ids so the same
  // referenced tree can be expanded in multiple places without colliding;
  // see buildLayoutTree() for how layout ids are namespaced.
  expandedSubtrees: Set<string>;
  layoutMode: LayoutMode;
  autoCollapseLevel: number;
  selectedTreeId: string | null;
  searchQuery: string;
  activeSidePanel: SidePanelKind;
  followMode: boolean;
}

/** The rendered scene: layout output and its DOM lookups, rebuilt by render(). */
export interface SceneState {
  layoutNodes: BTNode[];
  layoutEdges: LayoutEdge[];
  nodeElements: Map<string, SVGGElement>;
  edgeElements: EdgeElement[];
  nodeById: Map<string, BTNode>;
  // Parent map: nodeId -> parent node (built during flattenTree)
  parentMap: Map<string, BTNode>;
}

/** Live-monitor connection state and the last painted status overlay. */
export interface MonitorState {
  active: boolean;
  available: boolean;
  lastNodeStatuses: StatusMap;
  idleFadeTimer: ReturnType<typeof setTimeout> | null;
}

export interface ViewerContext {
  readonly vscode: VsCodeApi;

  treeData: TreeData | null;
  colors: ThemeColors;

  readonly camera: CameraState;
  readonly drag: DragState;
  readonly view: ViewState;
  readonly scene: SceneState;
  readonly monitor: MonitorState;

  // DOM refs
  readonly svg: SVGSVGElement;
  readonly treeGroup: SVGGElement;
  readonly edgeGroup: SVGGElement;
  readonly nodeGroup: SVGGElement;
  readonly tooltip: HTMLElement;
  readonly container: HTMLElement;
  readonly fileNameEl: HTMLElement;
  readonly zoomLevelEl: HTMLElement;
  readonly errorOverlay: HTMLElement;
  readonly errorMessage: HTMLElement;
  readonly btnFit: HTMLElement;
  readonly btnExportPdf: HTMLElement | null;
  readonly btnZoomIn: HTMLElement;
  readonly btnZoomOut: HTMLElement;
  readonly treeSelector: HTMLSelectElement;
  readonly searchInput: HTMLInputElement;
  readonly searchCount: HTMLElement;
  readonly btnBlackboard: HTMLElement;
  readonly btnPalette: HTMLElement;
  readonly sidePanel: HTMLElement;
  readonly sidePanelTitle: HTMLElement;
  readonly sidePanelContent: HTMLElement;
  readonly sidePanelGoto: HTMLElement | null;
  readonly sidePanelClose: HTMLElement;
  readonly btnLayoutToggle: HTMLElement | null;
  readonly btnExpandAll: HTMLElement | null;
  readonly btnCollapseAll: HTMLElement | null;
  readonly btnMonitor: HTMLElement;
  readonly btnFollow: HTMLElement | null;
  readonly depthInput: HTMLInputElement | null;
  readonly monitorStatusEl: HTMLElement;
  readonly minimap: HTMLCanvasElement | null;
  readonly minimapCtx: CanvasRenderingContext2D | null;
}

export interface CategoryColor {
  fill: string;
  stroke: string;
  text: string;
}

export interface StatusColors {
  running: string;
  success: string;
  failure: string;
  idle: string;
  edge: string;
  viewport: string;
}

export type ThemeColors = Record<string, CategoryColor> & { status: StatusColors };

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as T;
}

/** Build the context: acquire the VSCode API, resolve DOM refs, init state. */
export function createViewerContext(colors: ThemeColors): ViewerContext {
  const vscode = acquireVsCodeApi();

  const treeGroup = byId<HTMLElement>("tree-group") as unknown as SVGGElement;
  const edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  edgeGroup.setAttribute("id", "edge-group");
  nodeGroup.setAttribute("id", "node-group");
  treeGroup.appendChild(edgeGroup);
  treeGroup.appendChild(nodeGroup);

  const minimap = document.getElementById("minimap") as HTMLCanvasElement | null;

  return {
    vscode,

    treeData: null,
    colors,

    camera: {
      zoom: 1,
      panX: 0,
      panY: 40,
      isPanning: false,
      panStartX: 0,
      panStartY: 0,
    },

    drag: {
      node: null,
      offsetX: 0,
      offsetY: 0,
    },

    view: {
      collapsedNodes: new Set(),
      expandedSubtrees: new Set(),
      layoutMode: "auto",
      autoCollapseLevel: 3,
      selectedTreeId: null,
      searchQuery: "",
      activeSidePanel: null,
      followMode: false,
    },

    scene: {
      layoutNodes: [],
      layoutEdges: [],
      nodeElements: new Map(),
      edgeElements: [],
      nodeById: new Map(),
      parentMap: new Map(),
    },

    monitor: {
      active: false,
      available: true,
      lastNodeStatuses: {},
      idleFadeTimer: null,
    },

    svg: byId<HTMLElement>("tree-svg") as unknown as SVGSVGElement,
    treeGroup,
    edgeGroup,
    nodeGroup,
    tooltip: byId("tooltip"),
    container: byId("canvas-container"),
    fileNameEl: byId("file-name"),
    zoomLevelEl: byId("zoom-level"),
    errorOverlay: byId("error-overlay"),
    errorMessage: byId("error-message"),
    btnFit: byId("btn-fit"),
    btnExportPdf: document.getElementById("btn-export-pdf"),
    btnZoomIn: byId("btn-zoom-in"),
    btnZoomOut: byId("btn-zoom-out"),
    treeSelector: byId<HTMLSelectElement>("tree-selector"),
    searchInput: byId<HTMLInputElement>("search-input"),
    searchCount: byId("search-count"),
    btnBlackboard: byId("btn-blackboard"),
    btnPalette: byId("btn-palette"),
    sidePanel: byId("side-panel"),
    sidePanelTitle: byId("side-panel-title"),
    sidePanelContent: byId("side-panel-content"),
    sidePanelGoto: document.getElementById("side-panel-goto"),
    sidePanelClose: byId("side-panel-close"),
    btnLayoutToggle: document.getElementById("btn-layout-toggle"),
    btnExpandAll: document.getElementById("btn-expand-all"),
    btnCollapseAll: document.getElementById("btn-collapse-all"),
    btnMonitor: byId("btn-monitor"),
    btnFollow: document.getElementById("btn-follow"),
    depthInput: document.getElementById("depth-input") as HTMLInputElement | null,
    monitorStatusEl: byId("monitor-status"),
    minimap,
    minimapCtx: minimap ? minimap.getContext("2d") : null,
  };
}
