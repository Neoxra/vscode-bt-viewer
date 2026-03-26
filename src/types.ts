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

/** Colors for each node category -- "Mission Control" palette */
export const CATEGORY_COLORS: Record<NodeCategory, { fill: string; stroke: string; text: string }> = {
  root: { fill: "#334155", stroke: "#64748b", text: "#f1f5f9" },
  control: { fill: "#92400e", stroke: "#f59e0b", text: "#fef3c7" },
  decorator: { fill: "#065f46", stroke: "#10b981", text: "#d1fae5" },
  action: { fill: "#1e40af", stroke: "#3b82f6", text: "#dbeafe" },
  condition: { fill: "#713f12", stroke: "#eab308", text: "#fef9c3" },
  subtree: { fill: "#5b21b6", stroke: "#8b5cf6", text: "#ede9fe" },
  script: { fill: "#374151", stroke: "#9ca3af", text: "#e5e7eb" },
};

/** Well-known BT.CPP control flow nodes */
export const CONTROL_NODES = new Set([
  "Sequence",
  "ReactiveSequence",
  "SequenceWithMemory",
  "SequenceStar",
  "Fallback",
  "ReactiveFallback",
  "FallbackStar",
  "Parallel",
  "ParallelAll",
  "ParallelNode",
  "IfThenElse",
  "WhileDoElse",
  "Switch2",
  "Switch3",
  "Switch4",
  "Switch5",
  "Switch6",
]);

export const DECORATOR_NODES = new Set([
  "RetryUntilSuccessful",
  "Repeat",
  "ForceSuccess",
  "ForceFailure",
  "Inverter",
  "KeepRunningUntilFailure",
  "Delay",
  "RunOnce",
  "Timeout",
  "Precondition",
  "ConsumeQueue",
  "LoopInt",
  "LoopDouble",
  "LoopString",
  "UntimedSequence",
]);

export const CONDITION_NODES = new Set([
  "ScriptCondition",
  "AlwaysSuccess",
  "AlwaysFailure",
]);

export const SCRIPT_NODES = new Set(["Script", "SetBlackboard"]);
