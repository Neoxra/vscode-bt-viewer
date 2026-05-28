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
