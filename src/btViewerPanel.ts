import * as vscode from "vscode";
import * as path from "path";
import { parseBTXml, expandSubtrees } from "./btParser";
import { BTParsedFile, CATEGORY_COLORS } from "./types";
import { BTMonitor } from "./btMonitor";

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
  private expandSubtreesEnabled = false;
  private monitor: BTMonitor | null = null;

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
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "webview")],
      }
    );

    BTViewerPanel.currentPanel = new BTViewerPanel(panel, extensionUri, document);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, document: vscode.TextDocument) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.currentDocument = document;

    this.panel.webview.html = this.getWebviewContent();
    this.sendTreeData();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case "goToLine":
            if (this.currentDocument && message.line) {
              const range = new vscode.Range(message.line - 1, 0, message.line - 1, 0);
              vscode.window.showTextDocument(this.currentDocument, {
                selection: range,
                viewColumn: vscode.ViewColumn.One,
              });
            }
            break;
          case "toggleSubtrees":
            this.expandSubtreesEnabled = !this.expandSubtreesEnabled;
            this.sendTreeData();
            break;
          case "startMonitor": {
            const config = vscode.workspace.getConfiguration("behaviortreeViewer");
            const host = config.get<string>("monitorHost", "localhost");
            const port = config.get<number>("monitorPort", 1666);
            this.startMonitor(host, port);
            break;
          }
          case "stopMonitor":
            this.stopMonitor();
            break;
          case "fitToView":
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

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public update(document: vscode.TextDocument) {
    this.currentDocument = document;
    this.sendTreeData();
  }

  private startMonitor(host: string, port: number) {
    if (this.monitor?.isRunning) {
      this.stopMonitor();
      return;
    }

    this.monitor = new BTMonitor({
      onStatus: (status) => {
        this.panel.webview.postMessage({
          command: "monitorStatus",
          nodes: status.nodes,
          timestamp: status.timestamp,
        });
      },
      onInfo: (message) => {
        this.panel.webview.postMessage({
          command: "monitorInfo",
          message,
        });
        if (message === "Monitoring active") {
          this.panel.webview.postMessage({ command: "monitorConnected" });
        }
      },
      onError: (message) => {
        this.panel.webview.postMessage({
          command: "monitorError",
          message,
        });
      },
      onTree: (xml) => {
        // Parse the live tree (contains _uid attributes for correct status matching)
        // Respect the user's SubTrees expand preference
        try {
          let parsed = parseBTXml(xml);
          if (this.expandSubtreesEnabled) {
            parsed = expandSubtrees(parsed);
          }
          this.panel.webview.postMessage({
            command: "updateTree",
            data: parsed,
            fileName: "(live)",
            colors: CATEGORY_COLORS,
            fromMonitor: true,
          });
        } catch {
          // If parsing fails, continue with the file-based tree
        }
      },
    });

    this.monitor.start(host, port);
  }

  private stopMonitor() {
    if (this.monitor) {
      this.monitor.stop();
      this.monitor = null;
      this.panel.webview.postMessage({ command: "monitorStopped" });
    }
  }

  private sendTreeData() {
    if (!this.currentDocument) return;

    try {
      let parsed: BTParsedFile = parseBTXml(this.currentDocument.getText());
      if (this.expandSubtreesEnabled) {
        parsed = expandSubtrees(parsed);
      }
      this.panel.webview.postMessage({
        command: "updateTree",
        data: parsed,
        fileName: path.basename(this.currentDocument.uri.fsPath),
        colors: CATEGORY_COLORS,
      });
    } catch (e: any) {
      this.panel.webview.postMessage({
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
    <button id="btn-layout-toggle" class="toolbar-btn" title="Toggle horizontal/waterfall layout">Layout</button>
    <button id="btn-expand-all" class="toolbar-btn" title="Expand all nodes">All</button>
    <button id="btn-collapse-all" class="toolbar-btn" title="Collapse to depth">Min</button>
    <label class="toolbar-hint" title="Auto-collapse depth for large trees">Depth <input id="depth-input" type="number" min="1" max="20" value="3" class="toolbar-input depth-input" /></label>
    <span id="monitor-status" class="toolbar-hint"></span>
    <button id="btn-expand-subtrees" class="toolbar-btn" title="Expand SubTrees inline">SubTrees</button>
    <button id="btn-blackboard" class="toolbar-btn" title="Toggle Blackboard panel">BB</button>
    <button id="btn-palette" class="toolbar-btn" title="Toggle Node Palette">Palette</button>
    <button id="btn-fit" class="toolbar-btn" title="Fit to View (F)">Fit</button>
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
        <button id="side-panel-close" class="toolbar-btn side-panel-close-btn">x</button>
      </div>
      <div id="side-panel-content"></div>
    </div>
  </div>
  <div id="tooltip" class="tooltip hidden"></div>
  <div id="error-overlay" class="hidden">
    <div id="error-message"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
