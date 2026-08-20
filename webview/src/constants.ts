/**
 * @fileoverview Layout constants and theme colour reading shared across the
 * viewer modules.
 */

import { ThemeColors } from "./context";

// Host platform, resolved once on load. Linux is the primary target; Mac
// and Windows are detected so the Ctrl/Cmd tooltip label reads correctly.
// Anything else falls through to LINUX (Ctrl convention).
const Platform = Object.freeze({ LINUX: "linux", MAC: "mac", WINDOWS: "windows" });
const PLATFORM = (() => {
  const p = navigator.platform || "";
  if (/Mac/i.test(p)) return Platform.MAC;
  if (/Win/i.test(p)) return Platform.WINDOWS;
  return Platform.LINUX;
})();
export const MODIFIER_CLICK_LABEL = PLATFORM === Platform.MAC ? "Cmd+click" : "Ctrl+click";

// Layout constants
export const NODE_H = 32;
export const NODE_MIN_W = 80;
export const NODE_PADDING_X = 12;
export const LEVEL_GAP = 50;
export const SIBLING_GAP = 12;
export const PORT_LINE_H = 12;
export const CHAR_WIDTH = 6.4;

// Opacity used to tint node fills with their stroke colour so the same
// hex value works as both saturated stroke and translucent body fill.
export const NODE_FILL_OPACITY = 0.22;

// Categories the viewer knows how to colour. Order matches CSS var names.
export const CATEGORY_KEYS = [
  "root", "control", "decorator", "action",
  "condition", "subtree", "script",
];

/**
 * Read category and status colours from CSS custom properties. Returns a
 * map { cat -> { fill, stroke, text } } where fill === stroke (the rect
 * itself sets fill-opacity to soften the body). Re-running this picks up
 * whichever theme is active in VSCode at the moment of the call.
 */
export function readThemeColors(): ThemeColors {
  const rootStyle = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const raw = rootStyle.getPropertyValue(name).trim();
    return raw || fallback;
  };
  const text = v("--bt-cat-text", "#f1f5f9");
  const out = {} as ThemeColors;
  for (const cat of CATEGORY_KEYS) {
    const c = v(`--bt-cat-${cat}`, "#64748b");
    out[cat] = { fill: c, stroke: c, text };
  }
  out.status = {
    running: v("--status-running", "#38bdf8"),
    success: v("--status-success", "#34d399"),
    failure: v("--status-failure", "#f87171"),
    idle:    v("--status-idle",    "#334155"),
    edge:    v("--vscode-panel-border", "#555"),
    viewport: v("--vscode-editor-foreground", "#fff"),
  };
  return out;
}
