/**
 * `studio.instance` editor preview component (WS-4.2).
 *
 * Renders literally `<>{children}</>` — a React Fragment, zero DOM elements.
 * This is the entire point of the redesign this module exists for: see
 * `src/core/page-parser/inlineLocalComponents.ts`'s module header for why a
 * call site must not leave ANY element behind (`%`/flex height chains,
 * `>`/`+`/`:nth-child` combinators crossing it), and why that rules out even
 * `display: contents` (still a real element — `src/modules/alm/register.tsx`
 * uses that trick for a THIRD-PARTY host that cannot be relied on to forward
 * the editor's wrapper props, which is not this module's situation: this
 * module owns its own children and needs no host element for them at all).
 *
 * `nodeWrapperProps` (the editor's selection/hover/keyboard data attributes
 * and event handlers) is deliberately NOT spread here — a Fragment cannot
 * carry props. Selection geometry still works because `nodeVisualRect`
 * already falls back to the union of an element's children for any box-less
 * node (`src/admin/pages/site/canvas/canvasDomGeometry.ts`, built for the
 * `display: contents` design-system host and verified to generalize with
 * zero changes — see `instanceNodes.test.tsx`). Click-to-select-the-instance
 * (Figma's "click selects the instance, Enter/double-click enters it") needs
 * a click-routing mechanism analogous to the existing Visual Component
 * lock-down (`findEnclosingComponentRef` in
 * `src/admin/pages/site/canvas/canvasSelectionUtils.ts`) plus new store
 * "entered instance" state — deliberately NOT built in this pass; see this
 * work order's STATE.md handoff for what's needed. Until that lands, a click
 * inside an instance's subtree selects the specific descendant node under the
 * cursor, same as any other node on the canvas today.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import type { InstanceStoredProps } from './props'

export const InstanceEditor: React.FC<ModuleComponentProps<InstanceStoredProps>> = ({ children }) => {
  return <>{children}</>
}
