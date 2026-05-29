import * as vscode from "vscode";
import { BTViewerPanel } from "./btViewerPanel";

export function activate(context: vscode.ExtensionContext) {
  const openViewerCommand = vscode.commands.registerCommand(
    "behaviortree.openViewer",
    async (uri?: vscode.Uri) => {
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

  context.subscriptions.push(openViewerCommand);
}

export function deactivate() {}
