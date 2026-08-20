/**
 * @fileoverview PDF export: clones the live SVG, inlines the computed styles
 * it inherits from VSCode theme CSS, and renders it via jsPDF + svg2pdf. The
 * bytes go back to the extension host, which owns the save dialog.
 */

import { ViewerContext } from "./context";
import { getTreeBounds } from "./layout";

declare global {
  interface Window {
    jspdf?: { jsPDF: new (options: object) => JsPdfDocument };
    svg2pdf?: unknown;
  }
}

interface JsPdfDocument {
  svg(element: SVGElement, options: object): Promise<void>;
  output(type: "arraybuffer"): ArrayBuffer;
}

// Properties whose computed values must be inlined as SVG attributes so the
// exported PDF carries the same colours as the live view (the saved SVG is
// detached from the VSCode CSS that defines --bt-* and --vscode-* vars).
const SVG_STYLE_PROPS = [
  "fill", "fill-opacity",
  "stroke", "stroke-opacity", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "opacity", "font-size", "font-family", "font-weight", "text-anchor",
];

function inlineComputedStyles(originalEl: Element, clonedEl: Element): void {
  const originalChildren = originalEl.children;
  const clonedChildren = clonedEl.children;
  const cs = getComputedStyle(originalEl);
  for (const prop of SVG_STYLE_PROPS) {
    const value = cs.getPropertyValue(prop);
    // Preserve "none" -- SVG's attribute default for `fill` is BLACK,
    // not none, so dropping fill:none here is what made every edge path
    // render as a filled black polygon in the PDF.
    if (value && value !== "") {
      if (!clonedEl.hasAttribute(prop)) {
        clonedEl.setAttribute(prop, value.trim());
      }
    }
  }
  for (let i = 0; i < originalChildren.length; i++) {
    if (clonedChildren[i]) {
      inlineComputedStyles(originalChildren[i], clonedChildren[i]);
    }
  }
}

export async function exportTreeToPdf(ctx: ViewerContext): Promise<void> {
  if (typeof window.jspdf === "undefined" || typeof window.svg2pdf === "undefined") {
    ctx.vscode.postMessage({ command: "exportPdfError", message: "PDF libraries not loaded" });
    return;
  }
  if (ctx.layoutNodes.length === 0) {
    return;
  }

  const bounds = getTreeBounds(ctx);
  const PAD = 20;
  const width = Math.max(1, bounds.w + PAD * 2);
  const height = Math.max(1, bounds.h + PAD * 2);

  // Clone the live SVG so we can mutate it freely (reset transform, inline
  // computed styles) without disturbing what the user is looking at.
  const clone = ctx.svg.cloneNode(true) as SVGSVGElement;
  // Strip viewport sizing and apply a viewBox matching tree bounds so the
  // PDF page captures the entire tree.
  clone.removeAttribute("width");
  clone.removeAttribute("height");
  clone.setAttribute("viewBox", `${bounds.minX - PAD} ${bounds.minY - PAD} ${width} ${height}`);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  // Reset the pan/zoom transform on the cloned tree group so the export is
  // at 1:1 scale, not whatever the user has zoomed to.
  const clonedTreeGroup = clone.querySelector("#tree-group");
  if (clonedTreeGroup) {
    clonedTreeGroup.removeAttribute("transform");
  }

  // Inline computed styles for elements that rely on CSS (notably .bt-edge
  // strokes via --vscode-* vars). Walk in lockstep so we read from the
  // live DOM and write to the clone. Must run BEFORE we inject the
  // background rect, otherwise the child-by-child walk drifts out of sync.
  inlineComputedStyles(ctx.svg, clone);

  // Paint the PDF page background to match the active VSCode theme. jsPDF
  // defaults to white pages, which clashes hard with dark themes. Resolve
  // --vscode-editor-background against the live DOM and prepend a rect
  // that fills the entire viewBox before any tree content.
  const bgColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--vscode-editor-background")
    .trim() || "#0d1117";
  const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bgRect.setAttribute("x", String(bounds.minX - PAD));
  bgRect.setAttribute("y", String(bounds.minY - PAD));
  bgRect.setAttribute("width", String(width));
  bgRect.setAttribute("height", String(height));
  bgRect.setAttribute("fill", bgColor);
  clone.insertBefore(bgRect, clone.firstChild);

  // svg2pdf needs an in-DOM element; attach off-screen.
  const holder = document.createElement("div");
  holder.style.position = "absolute";
  holder.style.left = "-100000px";
  holder.style.top = "0";
  holder.style.width = `${width}px`;
  holder.style.height = `${height}px`;
  holder.appendChild(clone);
  document.body.appendChild(holder);

  try {
    const { jsPDF } = window.jspdf;
    const orientation = width > height ? "l" : "p";
    const pdf = new jsPDF({ orientation, unit: "pt", format: [width, height] });
    await pdf.svg(clone, { x: 0, y: 0, width, height });
    const ab = pdf.output("arraybuffer");
    // Pass as plain array; VSCode's webview message channel JSON-serialises
    // payloads, so a typed array would arrive as an object with numeric
    // keys. number[] survives the round-trip and reconstructs cleanly with
    // new Uint8Array(...) on the host side.
    const bytes = Array.from(new Uint8Array(ab));
    const baseName = (ctx.fileNameEl.textContent || "behavior-tree").replace(/\.[^.]+$/, "");
    ctx.vscode.postMessage({
      command: "exportPdf",
      bytes,
      fileName: `${baseName}.pdf`,
    });
  } catch (err) {
    ctx.vscode.postMessage({
      command: "exportPdfError",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    holder.remove();
  }
}
