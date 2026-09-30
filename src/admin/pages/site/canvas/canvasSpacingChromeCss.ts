/**
 * canvasSpacingChromeCss — how the padding / gap bands look inside a frame
 * (P5-E, IX-17). Appended to the portal injector's selection-chrome sheet
 * (`CanvasSelectionOverlayInjector`), so it is UNLAYERED like the rings —
 * user CSS can never hide it — and keyed to stable `data-*` hooks, because
 * CSS Module classes do not exist inside the iframe.
 *
 * Portal (design) frames only, so it lives here rather than in
 * `@core/studio-runtime`'s `selectionChromeCss.ts`: the live runtime has no
 * spacing handles, and that module is built into the runtime bundle.
 *
 * Colours are the Alt-measure padding tokens the chrome sheet already
 * forwards (`--canvas-measure-padding-*`), so a padding looks the same whether
 * it is measured or dragged. The two `cursor` declarations carry `!important`
 * for the resize handles' reason: a design frame's universal
 * `cursor: default !important` neutralises the page's own affordances, and
 * only `!important` beats `!important` on a universal selector. Nothing else
 * here needs it.
 */
export const SPACING_CHROME_RULES = `
[data-canvas-spacing-layer] {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

[data-canvas-spacing-band] {
  position: absolute;
  top: 0;
  left: 0;
  width: var(--band-width);
  height: var(--band-height);
  box-sizing: border-box;
  transform: translate(var(--band-x), var(--band-y));
  pointer-events: auto;
}

[data-canvas-spacing-band][data-spacing-axis="row"] { cursor: ns-resize !important; }
[data-canvas-spacing-band][data-spacing-axis="column"] { cursor: ew-resize !important; }

[data-canvas-spacing-band]:hover,
[data-canvas-spacing-band][data-spacing-active] {
  background: var(--canvas-measure-padding-fill);
  outline: 1px dashed var(--canvas-measure-padding-line);
  outline-offset: -1px;
}

[data-canvas-spacing-value] {
  position: absolute;
  top: 50%;
  left: 50%;
  display: none;
  transform: translate(-50%, -50%);
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  background: var(--canvas-measure-padding-line);
  color: var(--canvas-measure-padding-text);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
}

[data-canvas-spacing-band]:hover > [data-canvas-spacing-value],
[data-canvas-spacing-band][data-spacing-active] > [data-canvas-spacing-value] {
  display: block;
}

[data-canvas-spacing-dragging] > [data-canvas-spacing-band]:not([data-spacing-active]) {
  visibility: hidden;
}
`.trim()
