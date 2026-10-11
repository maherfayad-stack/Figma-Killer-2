import { describe, expect, it } from 'bun:test'
import { GlobalWindow } from 'happy-dom'
import { applyModeRootPlan, axisChoices, drivesColorScheme, isCatalogDrivenAxis, planModeRoot } from '../modeRoot'
import type { ModeAxis } from '../schema'

const attrScheme: ModeAxis = {
  id: 'color-scheme',
  label: 'Color scheme',
  modes: [
    { id: 'dark', label: 'Dark', gate: { kind: 'attr', attr: 'data-theme', value: 'dark' } },
    { id: 'light', label: 'Light', gate: { kind: 'attr', attr: 'data-theme', value: 'light' } },
  ],
}
const classScheme: ModeAxis = { id: 'color-scheme', label: 'Color scheme', modes: [{ id: 'dark', label: 'Dark', gate: { kind: 'class', className: 'dark' } }] }
const notLight: ModeAxis = {
  id: 'color-scheme',
  label: 'Color scheme',
  modes: [{ id: 'dark', label: 'Dark', gate: { kind: 'attr', attr: 'data-theme', value: 'light', negate: true } }],
}
const mediaScheme: ModeAxis = {
  id: 'color-scheme',
  label: 'Color scheme',
  modes: [{ id: 'dark', label: 'Dark', gate: { kind: 'media', query: '(prefers-color-scheme: dark)' } }],
}
const width: ModeAxis = {
  id: 'breakpoint',
  label: 'Breakpoint',
  modes: [{ id: '(min-width: 768px)', label: '(min-width: 768px)', gate: { kind: 'media', query: '(min-width: 768px)' } }],
}
const density: ModeAxis = {
  id: 'density',
  label: 'Density',
  modes: [{ id: 'compact', label: 'compact', gate: { kind: 'attr', attr: 'data-density', value: 'compact' } }],
}

function root() {
  return new GlobalWindow().document.documentElement as unknown as HTMLElement
}

describe('planModeRoot', () => {
  it('attribute gates: the chosen mode sets the attribute; two modes sharing one never undo each other', () => {
    expect(planModeRoot([attrScheme], { 'color-scheme': 'dark' }).attrs).toEqual({ 'data-theme': 'dark' })
    expect(planModeRoot([attrScheme], { 'color-scheme': 'light' }).attrs).toEqual({ 'data-theme': 'light' })
  })

  it('class gates: on for the chosen mode, off otherwise', () => {
    expect(planModeRoot([classScheme], { 'color-scheme': 'dark' }).classes).toEqual({ dark: true })
    expect(planModeRoot([classScheme], { 'color-scheme': 'light' }).classes).toEqual({ dark: false })
  })

  it('a negated gate (:not([data-theme=light])) is satisfied by anything but the negated value', () => {
    expect(planModeRoot([notLight], { 'color-scheme': 'dark' }).attrs).toEqual({ 'data-theme': 'dark' })
    expect(planModeRoot([notLight], { 'color-scheme': 'light' }).attrs).toEqual({ 'data-theme': 'light' })
  })

  it('an axis left on its default removes its gates', () => {
    expect(planModeRoot([density], {}).attrs).toEqual({ 'data-density': null })
    expect(planModeRoot([density], { density: 'compact' }).attrs).toEqual({ 'data-density': 'compact' })
  })

  it('plans nothing for media gates (the canvas rewrite and the frame width answer those) and for direction/locale', () => {
    expect(planModeRoot([mediaScheme, width], { 'color-scheme': 'dark' })).toEqual({ attrs: {}, classes: {} })
    const own: ModeAxis = { id: 'direction', label: 'Direction', modes: [{ id: 'rtl', label: 'RTL', gate: { kind: 'attr', attr: 'dir', value: 'rtl' } }] }
    expect(planModeRoot([own], { direction: 'rtl' })).toEqual({ attrs: {}, classes: {} })
    expect(isCatalogDrivenAxis('direction')).toBe(false)
    expect(isCatalogDrivenAxis('density')).toBe(true)
  })
})

describe('applyModeRootPlan', () => {
  it('writes the plan onto the root and is idempotent', () => {
    const html = root()
    const plan = planModeRoot([classScheme, density], { 'color-scheme': 'dark', density: 'compact' })
    applyModeRootPlan(html, plan)
    applyModeRootPlan(html, plan)
    expect(html.classList.contains('dark')).toBe(true)
    expect(html.getAttribute('data-density')).toBe('compact')
    applyModeRootPlan(html, planModeRoot([classScheme, density], { 'color-scheme': 'light' }))
    expect(html.classList.contains('dark')).toBe(false)
    expect(html.hasAttribute('data-density')).toBe(false)
  })
})

describe('axisChoices', () => {
  it('colour scheme always offers both modes (one is the :root default)', () => {
    expect(axisChoices(classScheme).map((c) => c.id)).toEqual(['light', 'dark'])
    expect(axisChoices(attrScheme).map((c) => c.label)).toEqual(['Light', 'Dark'])
  })
  it('other axes offer the default plus each mode', () => {
    expect(axisChoices(density)).toEqual([
      { id: null, label: 'Default' },
      { id: 'compact', label: 'compact' },
    ])
  })
  it('an axis whose modes cannot be emulated offers nothing, so no dead chip', () => {
    expect(axisChoices(width)).toEqual([])
  })
  it('only attribute/class colour axes count as driving the scheme from the catalog', () => {
    expect(drivesColorScheme([classScheme])).toBe(true)
    expect(drivesColorScheme([mediaScheme])).toBe(false)
  })
})
