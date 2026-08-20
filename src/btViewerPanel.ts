import * as vscode from "vscode";
import * as path from "path";
import { parseBTXml } from "./btParser";
import { BTParsedFile, BTNodeData } from "./types";
import { BTMonitor, isMonitorAvailable } from "./btMonitor";
import { BtLogReplay } from "./btLogReader";
import { HostToWebviewMessage, WebviewToHostMessage } from "../shared/protocol";

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}

export class BTViewerPanel {
  public static currentPanel: BTViewerPanel | undefined;
  private static readonly viewType = "behaviortreeViewer";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private currentDocument: vscode.TextDocument | undefined;
  // Set when the panel is showing a .btlog replay rather than a live file. Used
  // only for the panel title; playback itself lives entirely in the webview.
  private replayUri: vscode.Uri | undefined;
  private monitor: BTMonitor | null = null;
  // Caches for cross-file SubTree resolution. xmlIndex is a path -> tree IDs
  // map (built via regex over all .xml in the workspace); parsedFiles caches
  // full parses of files we actually pulled trees from. Both are invalidated
  // by the file system watcher on .xml changes.
  private xmlIndex: Map<string, string[]> | undefined;
  private parsedFileCache = new Map<string, BTParsedFile>();

  public static createOrShow(extensionUri: vscode.Uri, document: vscode.TextDocument) {
    const column = vscode.ViewColumn.Active;

    if (BTViewerPanel.currentPanel) {
      BTViewerPanel.currentPanel.panel.reveal(column);
      BTViewerPanel.currentPanel.update(document);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      BTViewerPanel.viewType,
      "BT Viewer",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "webview"),
          vscode.Uri.joinPath(extensionUri, "webview", "vendor"),
        ],
      }
    );

    BTViewerPanel.currentPanel = new BTViewerPanel(panel, extensionUri, document);
  }

  /**
   * Open (or reuse) the viewer to replay a decoded `.btlog` recording. Unlike
   * createOrShow there is no backing TextDocument: the tree XML and transitions
   * come from the recording, and playback runs in the webview.
   */
  public static createOrShowReplay(extensionUri: vscode.Uri, uri: vscode.Uri, replay: BtLogReplay) {
    const column = vscode.ViewColumn.Active;

    if (BTViewerPanel.currentPanel) {
      BTViewerPanel.currentPanel.panel.reveal(column);
      BTViewerPanel.currentPanel.showReplay(uri, replay);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      BTViewerPanel.viewType,
      "BT Replay",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "webview"),
          vscode.Uri.joinPath(extensionUri, "webview", "vendor"),
        ],
      }
    );

    const instance = new BTViewerPanel(panel, extensionUri, undefined);
    BTViewerPanel.currentPanel = instance;
    instance.showReplay(uri, replay);
  }

  /** Send a message to the webview, checked against the shared protocol. */
  private post(message: HostToWebviewMessage): void {
    this.panel.webview.postMessage(message);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, document: vscode.TextDocument | undefined) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.currentDocument = document;

    this.panel.webview.html = this.getWebviewContent();
    this.sendTreeData();
    this.post({
      command: "monitorAvailability",
      available: isMonitorAvailable(),
      reason: isMonitorAvailable()
        ? ""
        : "Live monitoring needs the native zeromq binary, which isn't available on this platform. The static tree viewer still works.",
    });

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToHostMessage) => {
        switch (message.command) {
          case "goToLine":
            if (message.line) {
              const lineNum = Math.max(0, message.line - 1);
              const range = new vscode.Range(lineNum, 0, lineNum, Number.MAX_SAFE_INTEGER);
              // Each node now carries its own source file (set when the tree
              // is parsed / resolved). Fall back to currentDocument for
              // legacy callers (live monitor nodes have no source file).
              const targetUri = message.file
                ? vscode.Uri.file(message.file)
                : this.currentDocument?.uri;
              if (!targetUri) break;
              const viewerColumn = this.panel.viewColumn;

              // Two-pane model: viewer in one column, source always in the
              // other. Pick the first tab group that isn't the viewer's. If
              // none exists yet, Beside creates a second column. We don't
              // search per-file -- showTextDocument(uri, viewColumn) reuses
              // any existing tab in that column for this URI automatically.
              let targetColumn: vscode.ViewColumn | undefined;
              for (const group of vscode.window.tabGroups.all) {
                if (group.viewColumn !== viewerColumn) {
                  targetColumn = group.viewColumn;
                  break;
                }
              }

              vscode.window.showTextDocument(targetUri, {
                selection: range,
                viewColumn: targetColumn ?? vscode.ViewColumn.Beside,
                preserveFocus: false,
                preview: false,
              });
            }
            break;
          case "startMonitor": {
            if (!isMonitorAvailable()) {
              this.post({
                command: "monitorError",
                message: "Live monitoring unavailable: zeromq native binary not loaded for this platform",
              });
              break;
            }
            const config = vscode.workspace.getConfiguration("behaviortreeViewer");
            const host = config.get<string>("monitorHost", "localhost");
            const port = config.get<number>("monitorPort", 1666);
            this.startMonitor(host, port);
            break;
          }
          case "stopMonitor":
            this.stopMonitor();
            break;
          case "exportPdf":
            this.handleExportPdf(message.bytes, message.fileName);
            break;
          case "exportPdfError":
            vscode.window.showErrorMessage(`BT Viewer: PDF export failed: ${message.message}`);
            break;
        }
      },
      null,
      this.disposables
    );

    // Watch for document changes (debounced to avoid jank during editing)
    const debouncedSend = debounce(() => this.sendTreeData(), 300);
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (this.currentDocument && e.document.uri.toString() === this.currentDocument.uri.toString()) {
          debouncedSend();
        }
      },
      null,
      this.disposables
    );

    vscode.window.onDidChangeActiveColorTheme(
      () => this.post({ command: "themeChanged" }),
      null,
      this.disposables
    );

    // Watch every .xml in the workspace so the SubTree resolver's caches
    // stay coherent across edits / new files / deletes. Surgical invalidates
    // when possible; full rebuild only when files appear or disappear.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.xml");
    watcher.onDidChange((uri) => {
      this.xmlIndex?.delete(uri.fsPath);
      this.parsedFileCache.delete(uri.fsPath);
    });
    watcher.onDidCreate(() => { this.xmlIndex = undefined; });
    watcher.onDidDelete((uri) => {
      this.xmlIndex?.delete(uri.fsPath);
      this.parsedFileCache.delete(uri.fsPath);
    });
    this.disposables.push(watcher);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public update(document: vscode.TextDocument) {
    this.currentDocument = document;
    this.replayUri = undefined;
    this.panel.title = "BT Viewer";
    this.sendTreeData();
  }

  /**
   * Load a decoded recording into the webview. Replay and the live monitor are
   * mutually exclusive, so any active monitor is stopped first. Parsing reuses
   * the normal XML parser: the embedded XML carries `_uid` on every node, which
   * is exactly what the webview matches transition uids against.
   */
  private showReplay(uri: vscode.Uri, replay: BtLogReplay) {
    this.stopMonitor();
    this.currentDocument = undefined;
    this.replayUri = uri;
    this.panel.title = `Replay: ${path.basename(uri.fsPath)}`;

    try {
      const parsed = parseBTXml(replay.xml);
      this.post({
        command: "loadReplay",
        data: parsed,
        fileName: path.basename(uri.fsPath),
        transitions: replay.transitions,
        duration: replay.duration,
        recordedAtMs: replay.recordedAtMs,
      });
    } catch (e: any) {
      this.post({
        command: "error",
        message: `Failed to parse tree from recording: ${e?.message || e}`,
      });
    }
  }

  private startMonitor(host: string, port: number) {
    if (this.monitor?.isRunning) {
      this.stopMonitor();
      return;
    }

    this.monitor = new BTMonitor({
      onStatus: (status) => {
        this.post({
          command: "monitorStatus",
          nodes: status.nodes,
        });
      },
      onInfo: (message) => {
        this.post({
          command: "monitorInfo",
          message,
        });
        if (message === "Monitoring active") {
          this.post({ command: "monitorConnected" });
        }
      },
      onError: (message) => {
        this.post({
          command: "monitorError",
          message,
        });
      },
      onTree: (xml) => {
        // Parse the live tree (contains _uid attributes for correct status matching).
        // SubTree expansion is now per-node in the webview, not a global flag.
        try {
          const parsed = parseBTXml(xml);
          this.post({
            command: "updateTree",
            data: parsed,
            fileName: "(live)",
          });
        } catch {
          // If parsing fails, continue with the file-based tree
        }
      },
    });

    this.monitor.start(host, port);
  }

  /**
   * Workspace-scoped index of `<BehaviorTree ID="X">` declarations across
   * all .xml files. Built lazily on first need via regex (no full parse) and
   * cached on the instance. Invalidated surgically by the file system watcher
   * when individual files change; fully rebuilt when files are added.
   */
  private async getXmlIndex(): Promise<Map<string, string[]>> {
    if (this.xmlIndex) return this.xmlIndex;
    const index = new Map<string, string[]>();
    const xmlFiles = await vscode.workspace.findFiles(
      "**/*.xml",
      "**/{node_modules,build,install,dist,.git,.venv,venv}/**",
      2000,
    );
    const decoder = new TextDecoder();
    const ID_RE = /<BehaviorTree\s+ID="([^"]+)"/g;
    await Promise.all(
      xmlFiles.map(async (uri) => {
        try {
          const text = decoder.decode(await vscode.workspace.fs.readFile(uri));
          if (!text.includes("<BehaviorTree")) return;
          const ids: string[] = [];
          for (const m of text.matchAll(ID_RE)) ids.push(m[1]);
          if (ids.length > 0) index.set(uri.fsPath, ids);
        } catch {
          // Unreadable file: skip silently.
        }
      }),
    );
    this.xmlIndex = index;
    return index;
  }

  /**
   * Merge SubTree definitions from anywhere in the workspace into the parsed
   * tree pool, so the tree-selector dropdown and "View SubTree" button can
   * navigate across files transparently. Uses a regex-built ID -> file map
   * (cheap) and only fully parses files we actually need to pull a tree from
   * (lazy). Both caches survive across `sendTreeData` calls until the file
   * watcher invalidates them.
   */
  private async resolveExternalSubtrees(parsed: BTParsedFile): Promise<BTParsedFile> {
    if (!this.currentDocument) return parsed;
    const docPath = this.currentDocument.uri.fsPath;

    // Collect unresolved SubTree references from the main parse.
    const knownIds = new Set(parsed.trees.map((t) => t.id));
    const queue: string[] = [];
    const enqueueRefs = (node: BTNodeData) => {
      if (node.category === "subtree") {
        const idPort = node.ports.find((p) => p.name === "ID");
        const treeName = idPort ? idPort.value : node.name;
        if (treeName && !knownIds.has(treeName)) queue.push(treeName);
      }
      for (const child of node.children) enqueueRefs(child);
    };
    for (const tree of parsed.trees) enqueueRefs(tree.root);
    if (queue.length === 0) return parsed;

    // Build / fetch the workspace ID index, then invert to id -> file lookup.
    const index = await this.getXmlIndex();
    const idToFile = new Map<string, string>();
    for (const [fp, ids] of index) {
      if (fp === docPath) continue;
      for (const id of ids) {
        if (!idToFile.has(id)) idToFile.set(id, fp);
      }
    }
    if (idToFile.size === 0) return parsed;

    const decoder = new TextDecoder();
    const getParsed = async (fp: string): Promise<BTParsedFile | undefined> => {
      const cached = this.parsedFileCache.get(fp);
      if (cached) return cached;
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fp));
        const sp = parseBTXml(decoder.decode(bytes), { resetIds: false });
        this.parsedFileCache.set(fp, sp);
        return sp;
      } catch {
        return undefined;
      }
    };

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (knownIds.has(id)) continue;
      const fp = idToFile.get(id);
      if (!fp) continue;
      const sp = await getParsed(fp);
      if (!sp) continue;
      const tree = sp.trees.find((t) => t.id === id);
      if (!tree) continue;
      tree.sourceFile = fp;
      parsed.trees.push(tree);
      knownIds.add(id);
      enqueueRefs(tree.root);
    }

    return parsed;
  }

  private stopMonitor() {
    if (this.monitor) {
      this.monitor.stop();
      this.monitor = null;
      this.post({ command: "monitorStopped" });
    }
  }

  private async sendTreeData() {
    if (!this.currentDocument) return;

    try {
      const docPath = this.currentDocument.uri.fsPath;
      let parsed: BTParsedFile = parseBTXml(this.currentDocument.getText());
      for (const tree of parsed.trees) tree.sourceFile = docPath;
      parsed = await this.resolveExternalSubtrees(parsed);
      this.post({
        command: "updateTree",
        data: parsed,
        fileName: path.basename(this.currentDocument.uri.fsPath),
      });
    } catch (e: any) {
      this.post({
        command: "error",
        message: e.message || "Failed to parse XML",
      });
    }
  }

  private getWebviewContent(): string {
    const webviewUri = (file: string) => {
      return this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "webview", file)
      );
    };

    const stylesUri = webviewUri("styles.css");
    const scriptUri = webviewUri("main.js");
    const jspdfUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview", "vendor", "jspdf.umd.min.js")
    );
    const svg2pdfUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview", "vendor", "svg2pdf.umd.min.js")
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${stylesUri}" rel="stylesheet">
  <title>BT Viewer</title>
</head>
<body>
  <div id="toolbar">
    <span id="file-name" class="toolbar-item"></span>
    <select id="tree-selector" class="toolbar-select" title="Select tree"></select>
    <div class="toolbar-spacer"></div>
    <div class="search-box">
      <input id="search-input" type="text" placeholder="Search nodes..." class="toolbar-input" />
      <span id="search-count" class="toolbar-hint"></span>
    </div>
    <button id="btn-monitor" class="toolbar-btn" title="Live monitor via ZMQ (port 1666)">Monitor</button>
    <button id="btn-follow" class="toolbar-btn" title="Auto-zoom to running nodes">Follow</button>
    <button id="btn-layout-toggle" class="toolbar-btn" title="Cycle view layout: Auto / Horizontal / Waterfall">View: Auto</button>
    <button id="btn-expand-all" class="toolbar-btn" title="Expand everything, including SubTrees">Expand All</button>
    <button id="btn-collapse-all" class="toolbar-btn" title="Reset to the Depth view (discard manual expand/collapse)">Reset</button>
    <label class="toolbar-hint" title="Auto-collapse depth for large trees">Depth <input id="depth-input" type="number" min="1" max="20" value="3" class="toolbar-input depth-input" /></label>
    <span id="monitor-status" class="toolbar-hint"></span>
    <button id="btn-blackboard" class="toolbar-btn" title="Toggle Blackboard panel">BB</button>
    <button id="btn-palette" class="toolbar-btn" title="Toggle Node Palette">Palette</button>
    <button id="btn-fit" class="toolbar-btn" title="Fit to View (F)">Fit</button>
    <button id="btn-export-pdf" class="toolbar-btn" title="Export an exact snapshot of the current view (theme colours, layout, expanded/collapsed nodes) as a PDF">Export to PDF</button>
    <button id="btn-zoom-in" class="toolbar-btn" title="Zoom In (+)">+</button>
    <button id="btn-zoom-out" class="toolbar-btn" title="Zoom Out (-)">-</button>
    <span id="zoom-level" class="toolbar-item">100%</span>
    <span class="toolbar-hint">R to reset</span>
  </div>
  <div id="main-area">
    <div id="canvas-container">
      <canvas id="minimap" width="180" height="130" title="Click to navigate"></canvas>
      <svg id="tree-svg">
        <defs>
          <filter id="drop-shadow" x="-10%" y="-10%" width="130%" height="130%">
            <feDropShadow dx="1" dy="2" stdDeviation="2" flood-opacity="0.15"/>
          </filter>
        </defs>
        <g id="tree-group"></g>
      </svg>
    </div>
    <div id="side-panel" class="hidden">
      <div id="side-panel-header">
        <span id="side-panel-title"></span>
        <div class="side-panel-header-actions">
          <button id="side-panel-goto" class="toolbar-btn side-panel-close-btn hidden" title="">Go to</button>
          <button id="side-panel-close" class="toolbar-btn side-panel-close-btn">x</button>
        </div>
      </div>
      <div id="side-panel-content"></div>
    </div>
  </div>
  <div id="tooltip" class="tooltip hidden"></div>
  <div id="error-overlay" class="hidden">
    <div id="error-message"></div>
  </div>
  <script nonce="${nonce}" src="${jspdfUri}"></script>
  <script nonce="${nonce}" src="${svg2pdfUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async handleExportPdf(bytes: number[] | undefined, fileName: string | undefined) {
    if (!bytes || !Array.isArray(bytes) || bytes.length === 0) {
      vscode.window.showErrorMessage("BT Viewer: PDF export produced no data");
      return;
    }
    const baseName = (fileName || "behavior-tree").replace(/\.pdf$/i, "");
    const sourceDir = this.currentDocument
      ? path.dirname(this.currentDocument.uri.fsPath)
      : undefined;
    const defaultUri = sourceDir
      ? vscode.Uri.file(path.join(sourceDir, `${baseName}.pdf`))
      : vscode.Uri.file(`${baseName}.pdf`);
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { PDF: ["pdf"] },
      saveLabel: "Export PDF",
    });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, new Uint8Array(bytes));
      const choice = await vscode.window.showInformationMessage(
        `BT Viewer: exported PDF to ${path.basename(target.fsPath)}`,
        "Reveal"
      );
      if (choice === "Reveal") {
        await vscode.commands.executeCommand("revealFileInOS", target);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`BT Viewer: failed to save PDF: ${err?.message || err}`);
    }
  }

  private dispose() {
    BTViewerPanel.currentPanel = undefined;
    this.stopMonitor();
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
