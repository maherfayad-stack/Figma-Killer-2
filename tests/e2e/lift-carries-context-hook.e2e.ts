import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame } from './helpers/canvasIframe'
import {
  countSourceOccurrences,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  removeFixtureProject,
  selectInFrame,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * The owner's bug, end to end: an element that reads `t` from
 * `const { t } = useLanguage()` dragged out of a frame onto the empty board
 * used to refuse with "Could not put that on the canvas" (`captured-scope`).
 * The lift now carries the hook the way a frame-to-frame move does — the
 * loose layer module makes the same call and imports the hook from
 * `.studio/canvas/` — and the free-canvas surface renders the translated text
 * for the PREVIEWED locale (Arabic here, so an English fallback cannot pass).
 *
 * Asserted on disk and on screen, never on the store.
 */

const TRANSLATIONS = `export const translations = {
  en: { sms: { title: 'Enter the code', resend: 'Resend' } },
  ar: { sms: { title: 'أدخل الرمز', resend: 'إعادة الإرسال' } },
}
`

const LANGUAGE_CONTEXT = `import { createContext, useContext, useMemo, useState } from 'react'
import { translations } from './translations'

const LanguageContext = createContext({ lang: 'en', t: translations.en })

export function LanguageProvider({ children }) {
  const [lang] = useState('en')
  const value = useMemo(() => ({ lang, t: translations[lang] }), [lang])
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  return ctx
}
`

const FIXTURE_PAGE = `import { useLanguage } from '../i18n/LanguageContext'
import './home.css'

export default function Home() {
  const { t } = useLanguage()
  return (
    <main className="home">
      <h1 className="home__title">{t.sms.title}</h1>
      <p className="home__body">{t.sms.resend}</p>
    </main>
  )
}
`

const FIXTURE_CSS = `.home { display: flex; flex-direction: column; gap: 24px; padding: 40px; min-height: 480px; background: #ffffff; }
.home__title { margin: 0; font-size: 32px; }
.home__body { margin: 0; font-size: 16px; }
`

const AR_TITLE = 'أدخل الرمز'

let fixture: FixtureProject

const rel = (...segments: string[]) => path.join(fixture.dir, ...segments)
const readPage = (): string => fs.readFileSync(rel('pages', 'Home.jsx'), 'utf8')
const layerModules = (): string[] => {
  const dir = rel('.studio', 'canvas')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^cl[a-z0-9]{10}\.tsx$/.test(name)) : []
}

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-lift-context-hook', {
    'pages/Home.jsx': FIXTURE_PAGE,
    'pages/home.css': FIXTURE_CSS,
    'i18n/translations.ts': TRANSLATIONS,
    'i18n/LanguageContext.jsx': LANGUAGE_CONTEXT,
    'package.json': JSON.stringify({ name: 'lift-context-fixture', private: true, type: 'module' }, null, 2) + '\n',
    '.studio/meta.json':
      JSON.stringify(
        {
          displayName: 'Zz Lift Context Fixture',
          platform: 'web',
          pagesDir: 'pages',
          trust: 'static',
          previewAxes: { direction: 'rtl', colorScheme: 'light', locale: 'ar' },
          frameDefaults: { width: 900, height: 600 },
        },
        null,
        2,
      ) + '\n',
    '.studio/boards.json':
      JSON.stringify(
        {
          version: 1,
          boards: [{ id: 'board-1', name: 'Board 1', frames: [{ id: 'f-home', pageId: 'home', x: 0, y: 0, width: 900, height: 600 }], notes: [], docs: [] }],
        },
        null,
        2,
      ) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 16): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
}

async function emptyBoardPoint(page: Page, canvasRoot: Locator, frame: Locator): Promise<{ x: number; y: number }> {
  const f = (await frame.boundingBox())!
  const r = (await canvasRoot.boundingBox())!
  const candidates = [
    { x: f.x + f.width + 120, y: f.y + 120 },
    { x: f.x + 120, y: f.y + f.height + 90 },
    { x: f.x - 160, y: f.y + 120 },
  ].filter((p) => p.x > r.x + 60 && p.x < r.x + r.width - 60 && p.y > r.y + 60 && p.y < r.y + r.height - 60)
  for (const point of candidates) {
    const onBoard = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') === 'canvas-root', point)
    if (onBoard) return point
  }
  throw new Error('emptyBoardPoint: no empty board next to the frame in the current view')
}


async function liftTitle(page: Page, copy: boolean): Promise<string> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  await zoomToPercent(page, canvasRoot, 50)
  const frame = await frameForPage(page, canvasRoot, 'home')
  const title = canvasContentFrame(frame).locator('.home__title')
  // The frame renders the previewed locale — the precondition the layer must match.
  await expect(title).toHaveText(AR_TITLE, { timeout: 60_000 })

  // Select the heading itself first: a plain press grabs the layer at the
  // selection depth (the page's <main>), not the nested element.
  await selectInFrame(page, title)
  // Opening the inspector re-fits the view; measure after it settles, and grab
  // the heading's empty (left, RTL) side rather than its glyphs.
  await page.waitForTimeout(500)
  const box = (await title.boundingBox())!
  const from = { x: box.x + 30, y: box.y + box.height / 2 }
  const to = await emptyBoardPoint(page, canvasRoot, frame)
  if (copy) await page.keyboard.down('Alt')
  await drag(page, from, to)
  if (copy) await page.keyboard.up('Alt')

  const toasts = page.locator('[data-toast-kind]')
  await expect
    .poll(async () => (layerModules().length > 0 ? 'written' : (await toasts.allTextContents()).join(' | ') || 'waiting'), {
      timeout: 60_000,
      message: 'no layer module was written (the value is the toast text, if one was shown)',
    })
    .toBe('written')
  expect(layerModules()).toHaveLength(1)
  const layerId = layerModules()[0]!.replace(/\.tsx$/, '')
  const moduleText = fs.readFileSync(rel('.studio', 'canvas', `${layerId}.tsx`), 'utf8')
  expect(moduleText).toContain(`import { useLanguage } from '../../i18n/LanguageContext'`)
  expect(moduleText).toContain('  const { t } = useLanguage()\n  return (')
  expect(moduleText).toContain('<h1 className="home__title">{t.sms.title}</h1>')

  // On screen: the loose layer renders the previewed locale's text.
  const layerTitle = page.frameLocator('iframe[data-studio-canvas-surface-frame]').locator(`[data-studio-layer-id="${layerId}"] h1`)
  await expect(layerTitle, 'the loose layer does not render the translated title').toHaveText(AR_TITLE, { timeout: 60_000 })

  expect(await toasts.allTextContents(), 'a refusal toast was shown').not.toContainEqual(expect.stringMatching(/could not put/i))
  return layerId
}

test.describe('lift onto the free canvas carries a context hook', () => {
  test.setTimeout(300_000)

  test('a move writes the layer with the hook, renders the Arabic title, and cuts the element exactly once', async ({ page }) => {
    await liftTitle(page, false)
    await expect.poll(readPage, { timeout: 60_000 }).not.toContain('<h1')
    const after = readPage()
    // The hook stays: the paragraph still reads `t`.
    expect(countSourceOccurrences(after, 'const { t } = useLanguage()')).toBe(1)
    expect(countSourceOccurrences(after, '{t.sms.resend}')).toBe(1)
    expect(after).toBe(FIXTURE_PAGE.replace('      <h1 className="home__title">{t.sms.title}</h1>\n', ''))
  })

  test('an Alt-drag copy writes the same layer and leaves the page byte-identical', async ({ page }) => {
    await liftTitle(page, true)
    expect(readPage()).toBe(FIXTURE_PAGE)
  })
})
