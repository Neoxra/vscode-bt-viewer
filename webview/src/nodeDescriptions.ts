/**
 * @fileoverview Built-in descriptions for BT.CPP's standard node types and
 * categories, plus the lookup that falls back to the file's TreeNodesModel.
 */

import { ViewerContext } from "./context";

export const NODE_DESCRIPTIONS: Record<string, string> = {
  // Category descriptions (keyed by category name)
  _cat_control: "Control nodes define the flow of execution through the tree. They have one or more children and decide the order and conditions under which children are ticked.",
  _cat_decorator: "Decorator nodes have exactly one child and modify its behavior or result. They can repeat, retry, invert, force success/failure, or add timeouts.",
  _cat_action: "Action nodes are leaves that perform work: calling ROS services, publishing messages, running computations, or interacting with hardware. They return SUCCESS, FAILURE, or RUNNING.",
  _cat_condition: "Condition nodes are leaves that check a state without side effects. They return SUCCESS (true) or FAILURE (false) and never return RUNNING.",
  _cat_subtree: "SubTree nodes reference another BehaviorTree defined in the same file, enabling modular and reusable tree composition.",
  _cat_script: "Script nodes execute inline expressions to read/write blackboard variables. Useful for variable initialization and simple transformations.",

  // Control nodes
  Sequence: "Ticks children left-to-right. Succeeds only if ALL children succeed. Fails immediately when any child fails. Restarts from first child on next tick.",
  ReactiveSequence: "Like Sequence, but re-ticks all children from the beginning on every tick. Useful for condition-guarded sequences where conditions must remain true.",
  SequenceWithMemory: "Like Sequence, but remembers which child was running and resumes from there on the next tick instead of restarting from the first child.",
  SequenceStar: "Alias for SequenceWithMemory.",
  Fallback: "Ticks children left-to-right. Succeeds immediately when any child succeeds. Fails only if ALL children fail. Used for recovery/alternative strategies.",
  ReactiveFallback: "Like Fallback, but re-ticks all children from the beginning on every tick. Useful for priority-based decision making with reactive conditions.",
  FallbackStar: "Like Fallback but with memory: resumes from the last running child instead of restarting.",
  Parallel: "Ticks all children simultaneously. Success/failure thresholds configurable. Default: succeeds if all succeed, fails if one fails.",
  ParallelAll: "Ticks all children in parallel. Succeeds when ALL children succeed. Fails if any child fails.",
  ParallelNode: "Alias for Parallel.",
  IfThenElse: "Three children: condition, then-branch, else-branch. Ticks condition first, then ticks the appropriate branch.",
  WhileDoElse: "Three children: condition, while-body, else-body. Keeps ticking while-body as long as condition succeeds; switches to else-body when condition fails.",
  Switch2: "Evaluates a variable and ticks one of 2 children based on the value, plus a default child.",
  Switch3: "Evaluates a variable and ticks one of 3 children based on the value, plus a default child.",
  Switch4: "Evaluates a variable and ticks one of 4 children based on the value, plus a default child.",
  Switch5: "Evaluates a variable and ticks one of 5 children based on the value, plus a default child.",
  Switch6: "Evaluates a variable and ticks one of 6 children based on the value, plus a default child.",

  // Decorator nodes
  RetryUntilSuccessful: "Retries its child up to N times until it succeeds. Fails if all attempts fail. Set num_attempts=-1 for infinite retries.",
  Repeat: "Repeats its child N times. Fails immediately if the child fails. Set num_cycles=-1 for infinite repetition.",
  ForceSuccess: "Always returns SUCCESS regardless of the child's result. Useful for optional/best-effort actions.",
  ForceFailure: "Always returns FAILURE regardless of the child's result.",
  Inverter: "Inverts the child's result: SUCCESS becomes FAILURE and vice versa. RUNNING is passed through.",
  KeepRunningUntilFailure: "Returns RUNNING as long as the child returns SUCCESS. Only returns FAILURE when the child fails.",
  Delay: "Waits for delay_msec milliseconds before ticking its child. Returns RUNNING during the delay.",
  RunOnce: "Ticks its child only once. On subsequent ticks, returns the same result as the first execution.",
  Timeout: "Ticks its child but returns FAILURE if it does not complete within the timeout period.",
  Precondition: "Checks a scripted condition before ticking its child. If the condition fails, returns FAILURE/SKIPPED without ticking the child.",

  // Condition/leaf nodes
  ScriptCondition: "Evaluates a script expression and returns SUCCESS if true, FAILURE if false. Used for blackboard variable checks.",
  AlwaysSuccess: "Always returns SUCCESS. Used as a placeholder or no-op.",
  AlwaysFailure: "Always returns FAILURE. Used for testing or forcing failure paths.",

  // Script nodes
  Script: "Executes a script expression that can read/write blackboard variables. Always returns SUCCESS.",
  SetBlackboard: "Sets a blackboard variable to a specified value. Always returns SUCCESS.",

  // SubTree
  SubTree: "References another BehaviorTree defined in the same file. Ports can be remapped between parent and child blackboards.",
  SubTreePlus: "Extended SubTree with automatic port remapping via _autoremap attribute.",
};

/** Get description for a node type. Checks built-in descriptions, then TreeNodesModel, then returns null. */
export function getNodeDescription(ctx: ViewerContext, nodeType: string): string | null {
  if (NODE_DESCRIPTIONS[nodeType]) return NODE_DESCRIPTIONS[nodeType];
  // Check if TreeNodesModel has a description for custom nodes
  if (ctx.treeData && ctx.treeData.nodeModels) {
    const model = ctx.treeData.nodeModels.find(m => m.type === nodeType);
    if (model && model.description) return model.description;
  }
  return null;
}
