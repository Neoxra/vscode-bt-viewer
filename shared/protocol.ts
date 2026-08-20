/**
 * @fileoverview The contract between the extension host and the webview:
 * the parsed-tree wire types and the message unions for both directions.
 * Everything that crosses postMessage is defined here, so the compiler can
 * check both sides against a single source of truth. This file must stay
 * dependency-free (no vscode, no DOM) — it is compiled into both bundles.
 */

export type NodeCategory =
  | "control"
  | "decorator"
  | "action"
  | "condition"
  | "subtree"
  | "script"
  | "root";

export interface BTPort {
  name: string;
  value: string;
  direction: "input" | "output" | "inout";
}

export interface BTNodeData {
  id: string;
  type: string;
  name: string;
  category: NodeCategory;
  ports: BTPort[];
  children: BTNodeData[];
  uid?: number;
  xmlLine?: number;
}

export interface BTTreeData {
  id: string;
  root: BTNodeData;
  /** Absolute path of the file this tree was parsed from. Used by the
   * goToLine message so the host opens the correct file when the user
   * Ctrl+clicks a node from a cross-file SubTree. */
  sourceFile?: string;
}

export interface BTParsedFile {
  mainTreeId: string;
  trees: BTTreeData[];
  nodeModels: BTNodeModel[];
}

export interface BTNodeModel {
  type: string;
  category: NodeCategory;
  ports: BTPortModel[];
  description?: string;
}

export interface BTPortModel {
  name: string;
  direction: "input" | "output" | "inout";
  type?: string;
  default?: string;
}

/** uid (as string) -> status name ("RUNNING", "SUCCESS", ...). */
export type StatusMap = Record<string, string>;

/** One status change from a .btlog recording, decoded on the host side. */
export interface ReplayTransition {
  /** Playback time in seconds from the start of the recording. */
  t: number;
  /** Node uid, matching the `_uid` attribute in the tree XML. */
  uid: number;
  /** Status name: IDLE | RUNNING | SUCCESS | FAILURE | SKIPPED. */
  status: string;
}

// ------ Host -> webview ------

export interface UpdateTreeMessage {
  command: "updateTree";
  data: BTParsedFile;
  fileName?: string;
}

export interface LoadReplayMessage {
  command: "loadReplay";
  data: BTParsedFile;
  fileName: string;
  transitions: ReplayTransition[];
  duration: number;
  recordedAtMs: number;
}

export interface ErrorMessage {
  command: "error";
  message: string;
}

export interface MonitorStatusMessage {
  command: "monitorStatus";
  nodes: StatusMap;
}

export interface MonitorInfoMessage {
  command: "monitorInfo";
  message: string;
}

export interface MonitorErrorMessage {
  command: "monitorError";
  message: string;
}

export interface MonitorConnectedMessage {
  command: "monitorConnected";
}

export interface MonitorStoppedMessage {
  command: "monitorStopped";
}

export interface MonitorAvailabilityMessage {
  command: "monitorAvailability";
  available: boolean;
  reason?: string;
}

export interface ThemeChangedMessage {
  command: "themeChanged";
}

export type HostToWebviewMessage =
  | UpdateTreeMessage
  | LoadReplayMessage
  | ErrorMessage
  | MonitorStatusMessage
  | MonitorInfoMessage
  | MonitorErrorMessage
  | MonitorConnectedMessage
  | MonitorStoppedMessage
  | MonitorAvailabilityMessage
  | ThemeChangedMessage;

// ------ Webview -> host ------

export interface GoToLineMessage {
  command: "goToLine";
  line: number;
  file?: string;
}

export interface StartMonitorMessage {
  command: "startMonitor";
}

export interface StopMonitorMessage {
  command: "stopMonitor";
}

export interface ExportPdfMessage {
  command: "exportPdf";
  bytes: number[];
  fileName: string;
}

export interface ExportPdfErrorMessage {
  command: "exportPdfError";
  message: string;
}

export type WebviewToHostMessage =
  | GoToLineMessage
  | StartMonitorMessage
  | StopMonitorMessage
  | ExportPdfMessage
  | ExportPdfErrorMessage;
