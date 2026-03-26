import { XMLParser } from "fast-xml-parser";
import {
  BTNodeData,
  BTPort,
  BTTreeData,
  BTParsedFile,
  BTNodeModel,
  BTPortModel,
  NodeCategory,
  CONTROL_NODES,
  DECORATOR_NODES,
  CONDITION_NODES,
  SCRIPT_NODES,
} from "./types";

// Attributes that are not ports
const RESERVED_ATTRS = new Set(["ID", "name", "BTCPP_format", "main_tree_to_execute", "num_attempts", "num_cycles", "delay_msec", "if", "else", "_description", "_autoremap", "_uid", "_fullpath"]);

let nodeIdCounter = 0;

function nextId(): string {
  return `node_${nodeIdCounter++}`;
}

export function categorizeNode(tagName: string, nodeModels: Map<string, NodeCategory>): NodeCategory {
  if (tagName === "BehaviorTree" || tagName === "root") return "root";
  if (tagName === "SubTree" || tagName === "SubTreePlus") return "subtree";
  if (CONTROL_NODES.has(tagName)) return "control";
  if (DECORATOR_NODES.has(tagName)) return "decorator";
  if (CONDITION_NODES.has(tagName)) return "condition";
  if (SCRIPT_NODES.has(tagName)) return "script";
  if (nodeModels.has(tagName)) return nodeModels.get(tagName)!;
  return "action";
}

function extractPorts(
  attrs: Record<string, string>,
  portModels?: Map<string, BTPortModel[]>,
  nodeType?: string,
): BTPort[] {
  const ports: BTPort[] = [];
  const declaredPorts = new Map<string, "input" | "output" | "inout">();
  if (portModels && nodeType) {
    const models = portModels.get(nodeType);
    if (models) {
      for (const m of models) {
        declaredPorts.set(m.name, m.direction);
      }
    }
  }

  for (const [key, value] of Object.entries(attrs)) {
    if (RESERVED_ATTRS.has(key)) continue;
    const strVal = String(value);
    let direction: "input" | "output" | "inout" = "input";
    if (declaredPorts.has(key)) {
      direction = declaredPorts.get(key)!;
    } else {
      const isBlackboardRef = strVal.startsWith("{") && strVal.endsWith("}");
      if (isBlackboardRef) direction = "inout";
    }
    ports.push({ name: key, value: strVal, direction });
  }
  return ports;
}

// ---- preserveOrder helpers ----
// With preserveOrder: true, each element is: { tagName: childrenArray, ":@": { "@_attr": val } }
// The tag name is the first key that isn't ":@" or "#text"

function getTagName(el: any): string | null {
  for (const key of Object.keys(el)) {
    if (key !== ":@" && key !== "#text") return key;
  }
  return null;
}

function getAttrs(el: any): Record<string, string> {
  const attrs: Record<string, string> = {};
  const raw = el[":@"];
  if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith("@_")) {
        attrs[key.substring(2)] = String(value);
      }
    }
  }
  return attrs;
}

function getChildren(el: any, tagName: string): any[] {
  return Array.isArray(el[tagName]) ? el[tagName] : [];
}

function parseNodeElement(
  el: any,
  tagName: string,
  nodeModels: Map<string, NodeCategory>,
  portModels: Map<string, BTPortModel[]>,
): BTNodeData {
  const attrs = getAttrs(el);
  const category = categorizeNode(tagName, nodeModels);
  const ports = extractPorts(attrs, portModels, tagName);

  // Script/ScriptCondition: use code as display name if no explicit name
  let displayName = attrs["name"] || attrs["ID"] || tagName;
  const isScriptNode = tagName === "Script" || tagName === "ScriptCondition" || tagName === "SetBlackboard";
  if (isScriptNode && !attrs["name"] && attrs["code"]) {
    displayName = attrs["code"];
  }
  // LogMessage: use message as display name if no explicit name
  if (tagName === "LogMessage" && !attrs["name"] && attrs["message"]) {
    displayName = attrs["message"];
  }

  const uid = attrs["_uid"] !== undefined ? parseInt(attrs["_uid"], 10) : undefined;

  // Add special attributes as ports for display
  for (const special of ["num_attempts", "num_cycles", "delay_msec"]) {
    if (attrs[special]) {
      ports.unshift({ name: special, value: attrs[special], direction: "input" });
    }
  }
  if (attrs["code"] && !(isScriptNode && !attrs["name"])) {
    ports.unshift({ name: "code", value: attrs["code"], direction: "input" });
  }
  if (attrs["if"]) {
    ports.unshift({ name: "if", value: attrs["if"], direction: "input" });
  }

  // Parse children IN DOCUMENT ORDER (preserveOrder: true gives us an array)
  const children: BTNodeData[] = [];
  const childElements = getChildren(el, tagName);
  for (const childEl of childElements) {
    const childTag = getTagName(childEl);
    if (!childTag || childTag === "#text") continue;
    children.push(parseNodeElement(childEl, childTag, nodeModels, portModels));
  }

  return {
    id: nextId(),
    type: tagName,
    name: displayName,
    category,
    ports,
    children,
    uid,
  };
}

function parseTreeNodesModel(
  rootChildren: any[],
): { models: BTNodeModel[]; modelMap: Map<string, NodeCategory>; portModelMap: Map<string, BTPortModel[]> } {
  const models: BTNodeModel[] = [];
  const modelMap = new Map<string, NodeCategory>();
  const portModelMap = new Map<string, BTPortModel[]>();

  // Find the TreeNodesModel element in the root's children
  const treeNodesModelEl = rootChildren.find((el: any) => getTagName(el) === "TreeNodesModel");
  if (!treeNodesModelEl) return { models, modelMap, portModelMap };

  const categoryMap: Record<string, NodeCategory> = {
    Action: "action",
    Condition: "condition",
    Control: "control",
    Decorator: "decorator",
    SubTree: "subtree",
  };

  const modelChildren = getChildren(treeNodesModelEl, "TreeNodesModel");
  for (const catEl of modelChildren) {
    const categoryTag = getTagName(catEl);
    if (!categoryTag) continue;
    const category = categoryMap[categoryTag] || "action";
    const catAttrs = getAttrs(catEl);
    const nodeId = catAttrs["ID"];
    if (!nodeId) continue;

    const ports: BTPortModel[] = [];
    const portChildren = getChildren(catEl, categoryTag);
    for (const portEl of portChildren) {
      const portTag = getTagName(portEl);
      if (!portTag) continue;
      const portAttrs = getAttrs(portEl);
      const portDir = portTag.startsWith("input") ? "input" : portTag.startsWith("output") ? "output" : "inout";
      if (portAttrs["name"]) {
        ports.push({
          name: portAttrs["name"],
          direction: portDir as "input" | "output" | "inout",
          type: portAttrs["type"],
          default: portAttrs["default"],
        });
      }
    }

    const description = catAttrs["_description"] || catAttrs["description"] || undefined;
    models.push({ type: nodeId, category, ports, description });
    modelMap.set(nodeId, category);
    if (ports.length > 0) portModelMap.set(nodeId, ports);
  }

  return { models, modelMap, portModelMap };
}

export function parseBTXml(xmlContent: string): BTParsedFile {
  nodeIdCounter = 0;

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
    preserveOrder: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlContent);

  // With preserveOrder: true, parsed is an array of top-level elements
  // Find the <root> element
  const rootEl = parsed.find((el: any) => getTagName(el) === "root");
  if (!rootEl) {
    throw new Error("Invalid BT XML: no <root> element found");
  }

  const rootAttrs = getAttrs(rootEl);
  const mainTreeId = rootAttrs["main_tree_to_execute"] || "MainTree";
  const rootChildren = getChildren(rootEl, "root");

  // Parse TreeNodesModel
  const { models, modelMap, portModelMap } = parseTreeNodesModel(rootChildren);

  // Parse all BehaviorTree elements IN ORDER
  const trees: BTTreeData[] = [];
  for (const btEl of rootChildren) {
    const btTag = getTagName(btEl);
    if (btTag !== "BehaviorTree") continue;

    const btAttrs = getAttrs(btEl);
    const treeId = btAttrs["ID"] || "UnnamedTree";
    const btChildren = getChildren(btEl, "BehaviorTree");

    // Find the first child element (root node of this tree)
    let rootNode: BTNodeData | null = null;
    for (const childEl of btChildren) {
      const childTag = getTagName(childEl);
      if (!childTag || childTag === "#text") continue;
      rootNode = parseNodeElement(childEl, childTag, modelMap, portModelMap);
      break;
    }

    if (rootNode) {
      trees.push({ id: treeId, root: rootNode });
    }
  }

  return { mainTreeId, trees, nodeModels: models };
}

/**
 * Expand SubTree references inline, replacing SubTree nodes with the actual tree content.
 */
export function expandSubtrees(parsed: BTParsedFile): BTParsedFile {
  const treeMap = new Map<string, BTTreeData>();
  for (const tree of parsed.trees) {
    treeMap.set(tree.id, tree);
  }

  function expandNode(node: BTNodeData, visited: Set<string>): BTNodeData {
    if (node.category === "subtree") {
      const treeName = node.ports.find(p => p.name === "ID")?.value || node.name;
      const tree = treeMap.get(treeName);

      if (tree && !visited.has(tree.id)) {
        visited.add(tree.id);
        const expanded = expandNode(JSON.parse(JSON.stringify(tree.root)), visited);
        visited.delete(tree.id);
        return {
          ...expanded,
          name: `[${treeName}] ${expanded.name}`,
        };
      }
    }

    return {
      ...node,
      children: node.children.map((c) => expandNode(c, new Set(visited))),
    };
  }

  const mainTree = parsed.trees.find((t) => t.id === parsed.mainTreeId) || parsed.trees[0];
  if (!mainTree) return parsed;

  const expandedRoot = expandNode(JSON.parse(JSON.stringify(mainTree.root)), new Set([mainTree.id]));

  return {
    ...parsed,
    trees: [{ id: mainTree.id, root: expandedRoot }],
  };
}
