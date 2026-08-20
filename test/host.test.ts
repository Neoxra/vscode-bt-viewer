/**
 * @fileoverview Extension-host smoke test. Runs inside a real VS Code via
 * @vscode/test-cli and exercises the panel paths the webview harness cannot
 * reach: command activation, panel construction (which posts to the webview),
 * the .btlog replay route, and panel reuse. A throw anywhere in the
 * host->webview message path fails these tests.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

function fixturePath(name: string): string {
  const folders = vscode.workspace.workspaceFolders;
  assert.ok(folders && folders.length > 0, "test workspace folder missing");
  return path.join(folders[0].uri.fsPath, name);
}

function allTabLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label));
}

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(predicate(), `timed out waiting for ${what}; tabs: ${allTabLabels().join(", ")}`);
}

/**
 * Build a minimal version-1 .btlog: magic, u32 xml size, tree XML with _uid
 * attributes, u64 start timestamp (microseconds), then 9-byte transition
 * records (u48 delta micros, u16 uid, u8 status).
 */
function buildBtLog(xml: string): Buffer {
  const xmlBytes = Buffer.from(xml, "utf-8");
  const header = Buffer.alloc(18 + 1 + 4);
  header.write("BTCPP4-FileLogger2", 0, "latin1");
  header.writeUInt8(1, 18);
  header.writeUInt32LE(xmlBytes.length, 19);

  const startMicros = Buffer.alloc(8);
  startMicros.writeBigUInt64LE(1755600000000000n);

  const record = (deltaMicros: number, uid: number, status: number): Buffer => {
    const b = Buffer.alloc(9);
    b.writeUIntLE(deltaMicros, 0, 6);
    b.writeUInt16LE(uid, 6);
    b.writeUInt8(status, 8);
    return b;
  };

  return Buffer.concat([
    header, xmlBytes, startMicros,
    record(0, 1, 1),        // root_seq RUNNING
    record(100000, 2, 2),   // first SUCCESS
    record(200000, 3, 2),   // second SUCCESS
    record(300000, 1, 2),   // root_seq SUCCESS
  ]);
}

suite("BT Viewer host smoke", () => {
  test("openViewer on a tree XML creates the panel", async () => {
    const uri = vscode.Uri.file(fixturePath("simple_tree.xml"));
    // Panel construction posts monitorAvailability and updateTree to the
    // webview; a broken outbound path rejects this command.
    await vscode.commands.executeCommand("behaviortree.openViewer", uri);
    await waitFor("viewer tab", () => allTabLabels().includes("BT Viewer"));
  });

  test("openViewer on a .btlog routes to replay", async () => {
    const btlogPath = fixturePath("generated_tree.btlog");
    const xml = fs.readFileSync(fixturePath("simple_tree.xml"), "utf-8");
    fs.writeFileSync(btlogPath, buildBtLog(xml));

    await vscode.commands.executeCommand("behaviortree.openViewer", vscode.Uri.file(btlogPath));
    await waitFor("replay tab", () =>
      allTabLabels().some(l => l.startsWith("Replay:") && l.includes("generated_tree.btlog")));
  });

  test("replayRecording command opens replay directly", async () => {
    const btlogPath = fixturePath("generated_tree.btlog");
    await vscode.commands.executeCommand("behaviortree.replayRecording", vscode.Uri.file(btlogPath));
    await waitFor("replay tab", () => allTabLabels().some(l => l.startsWith("Replay:")));
  });

  test("reopening a tree XML reuses the panel and exits replay", async () => {
    const uri = vscode.Uri.file(fixturePath("simple_tree.xml"));
    await vscode.commands.executeCommand("behaviortree.openViewer", uri);
    await waitFor("viewer tab back", () => allTabLabels().includes("BT Viewer"));
    const viewerTabs = allTabLabels().filter(l => l === "BT Viewer" || l.startsWith("Replay:"));
    assert.strictEqual(viewerTabs.length, 1, `expected one viewer panel, got: ${viewerTabs.join(", ")}`);
  });
});
