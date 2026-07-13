import * as vscode from "vscode";
import { BTViewerPanel } from "./btViewerPanel";
import { readBtLog } from "./btLogReader";

/**
 * Decode a `.btlog` recording and open (or reuse) the viewer in replay mode.
 * `.btlog` is binary, so we read raw bytes rather than opening a TextDocument.
 */
async function openReplay(extensionUri: vscode.Uri, uri: vscode.Uri) {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const replay = readBtLog(bytes);
    BTViewerPanel.createOrShowReplay(extensionUri, uri, replay);
  } catch (e: any) {
    vscode.window.showErrorMessage(`BT Viewer: could not replay recording: ${e?.message || e}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const openViewerCommand = vscode.commands.registerCommand(
    "behaviortree.openViewer",
    async (uri?: vscode.Uri) => {
      // A .btlog recording is binary: route it to the replay path instead of
      // trying to open it as a text document.
      if (uri && uri.fsPath.endsWith(".btlog")) {
        await openReplay(context.extensionUri, uri);
        return;
      }

      // If invoked from explorer context menu, uri is the file
      // If invoked from editor context menu or command palette, try active editor
      let document: vscode.TextDocument | undefined;

      if (uri) {
        document = await vscode.workspace.openTextDocument(uri);
      } else if (vscode.window.activeTextEditor) {
        document = vscode.window.activeTextEditor.document;
      } else {
        // No uri and no active editor - try to find an open XML tab
        const xmlEditors = vscode.window.visibleTextEditors.filter(
          (e) => e.document.languageId === "xml"
        );
        if (xmlEditors.length === 1) {
          document = xmlEditors[0].document;
        } else if (xmlEditors.length > 1) {
          const pick = await vscode.window.showQuickPick(
            xmlEditors.map((e) => ({
              label: e.document.fileName.split("/").pop() || e.document.fileName,
              editor: e,
            })),
            { placeHolder: "Select a BT XML file to view" }
          );
          if (pick) document = pick.editor.document;
        }
      }

      if (!document) {
        vscode.window.showErrorMessage(
          "No XML file found. Open a BT XML file first or right-click it in the explorer."
        );
        return;
      }

      // No upfront sniff: if the file isn't valid BT XML, parseBTXml in the
      // panel throws and the webview's error overlay surfaces the parse
      // failure. That's a single, less interruptive feedback path.
      BTViewerPanel.createOrShow(context.extensionUri, document);
    }
  );

  const replayCommand = vscode.commands.registerCommand(
    "behaviortree.replayRecording",
    async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showErrorMessage(
          "No .btlog recording selected. Right-click a .btlog file in the explorer to replay it."
        );
        return;
      }
      await openReplay(context.extensionUri, target);
    }
  );

  context.subscriptions.push(openViewerCommand, replayCommand);
}

export function deactivate() {}
