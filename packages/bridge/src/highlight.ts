import { findByUid } from './dom.js';

/**
 * `set-hover` / `set-selection` — "optional in-iframe highlight (no
 * reply); primary selection/hover rendering is the studio canvas-space
 * overlay" (ADR-0016). Kept deliberately minimal: a single injected
 * `<style>` tag + class toggling, no framework, no persisted state beyond
 * "which uid(s) currently have the class."
 */

const STYLE_ELEMENT_ID = 'ccs-bridge-highlight-style';
const HOVER_CLASS = 'ccs-bridge-hover';
const SELECTED_CLASS = 'ccs-bridge-selected';

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    .${HOVER_CLASS} { outline: 2px solid #0ea5e9 !important; outline-offset: -1px; }
    .${SELECTED_CLASS} { outline: 2px solid #6366f1 !important; outline-offset: -1px; }
  `;
  doc.head.appendChild(style);
}

export function setHover(uid: string | null, doc: Document = document): void {
  ensureStyle(doc);
  for (const el of doc.querySelectorAll(`.${HOVER_CLASS}`)) {
    el.classList.remove(HOVER_CLASS);
  }
  if (uid) findByUid(doc, uid)?.classList.add(HOVER_CLASS);
}

export function setSelection(uids: string[], doc: Document = document): void {
  ensureStyle(doc);
  for (const el of doc.querySelectorAll(`.${SELECTED_CLASS}`)) {
    el.classList.remove(SELECTED_CLASS);
  }
  for (const uid of uids) {
    findByUid(doc, uid)?.classList.add(SELECTED_CLASS);
  }
}
