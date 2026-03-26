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

      // Quick check: is this a BT.CPP XML file?
      const text = document.getText(new vscode.Range(0, 0, 15, 0));
      if (!text.includes("BTCPP_format") && !text.includes("BehaviorTree")) {
        const choice = await vscode.window.showWarningMessage(
          "This file does not appear to be a BehaviorTree.CPP XML file. Open viewer anyway?",
          "Yes",
          "No"
        );
        if (choice !== "Yes") return;
      }

      BTViewerPanel.createOrShow(context.extensionUri, document);
    }
  );

  context.subscriptions.push(openViewerCommand);
}

export function deactivate() {}
