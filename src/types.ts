// The parsed-tree data types live in shared/protocol.ts (the host<->webview
// contract); re-exported here so host modules keep their existing imports.
export {
  BTNodeData,
  BTNodeModel,
  BTParsedFile,
  BTPort,
  BTPortModel,
  BTTreeData,
  NodeCategory,
} from "../shared/protocol";

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
