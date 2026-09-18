/**
 * studioFixtureProject — driving a REAL Studio project from a Playwright spec
 * without touching the one a human has open.
 *
 * Every gesture the Phase 0 exit dogfood exercises (⌘D, Alt+drag, ⌘G, ⌘⇧G)
 * writes to the user's `.tsx` on disk. A spec that drove
 * `studio-workspace/test4` directly would leave five duplicated elements and a
 * `<div>` wrapper behind in a tracked corpus every other spec measures. So the
 * contract here is: **copy the project, open the copy, delete the copy**.
 *
 * The copy has to live under the workspace root rather than anywhere else —
 * `resolveProjectDir`'s containment check 404s anything outside it. Same
 * constraint `scripts/bench/lib/liveFrameFixture.ts` and
 * `tests/e2e/studio-feel.e2e.ts` both document.
 *
 * That root is `WORKSPACE_ROOT` from `./constants`: this RUN's throwaway copy
 * of `studio-workspace/`, made by `scripts/e2e-dev.ts` and pointed at by
 * `STUDIO_WORKSPACE_DIR`. So the copy-open-delete contract below is the second
 * of two layers, and still worth having — specs share one workspace for the
 * whole serial run, so a spec that structurally edits `test4` would change what
 * every later spec reads, throwaway root or not.
 *
 * Nothing in this module asserts. It only gets a spec to the point where a
 * real board is on screen, a real element is selected, and the file that
 * element came from can be read off disk — the four things every case in
 * `studio-feel-phase0.e2e.ts` needs before it can measure anything.
 */
import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WORKSPACE_ROOT } from './constants'

/** Selector for a design-mode canvas iframe, inside a board frame. */
export const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'
/** The in-frame selection ring the overlay paints around the selected node. */
export const SELECTION_RING = '[data-canvas-selection-ring="true"]'

export interface FixtureProject {
  /** Absolute path of the ephemeral copy — what Studio is pointed at. */
  readonly dir: string
  /** `false` when the source project is not on disk; the spec skips itself. */
  readonly ready: boolean
}

/**
 * Copy `studio-workspace/<sourceName>` to `studio-workspace/<fixtureName>`.
 *
 * The fixture name is FIXED rather than per-PID: a crashed run's leftovers are
 * visibly overwritten by the next run rather than accumulating one abandoned
 * 3 MB copy per crash.
 */
export function createFixtureProject(sourceName: string, fixtureName: string): FixtureProject {
  const source = path.join(WORKSPACE_ROOT, sourceName)
  const dir = path.join(WORKSPACE_ROOT, fixtureName)
  if (!fs.existsSync(source)) return { dir, ready: false }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(source, dir, { recursive: true })
  return { dir, ready: true }
}

/**
 * Delete the copy, retrying a Windows sharing violation.
 *
 * A spec that ran a real agent turn leaves a WARM `claude` process whose
 * `cwd` IS this directory (`claudeCliSessionPool.ts` holds it for up to ten
 * idle minutes), and Windows refuses to unlink a directory that is some
 * process's working directory — `EPERM`, not `EBUSY`. The product's own way
 * to end that process is deleting the conversation, which a spec should do
 * before it gets here; this loop covers the rest (a still-draining stream, a
 * file watcher) rather than leaving a 3 MB copy behind on the first blip.
 *
 * Never throws: failing to clean up a throwaway directory must not turn a
 * green run red. The fixture name is fixed, so the next run overwrites it.
 */
 * A fixture project the spec AUTHORS, rather than copies — an empty directory
 * under the workspace root, with its files written by the caller.
 *
 * Three specs (`css-writeback`, `structural-writeback`, `design-system-insert`)
 * used to build their fixture with `fs.mkdtempSync(os.tmpdir())` and open it by
 * absolute path. That cannot work: `resolveProjectDir`'s containment check
 * rejects any directory outside the root the SERVER resolved, so the board
 * route answers 404 and the spec fails on a timeout that reads like a product
 * bug. The safety argument those specs make — "never write into
 * `studio-workspace/`" — is satisfied by `WORKSPACE_ROOT` being this run's
 * throwaway copy (`scripts/e2e-dev.ts`), which is exactly what an OS temp dir
 * was reaching for.
 *
 * The name is FIXED, not per-PID, for the same reason `createFixtureProject`'s
 * is: a crashed run's leftovers are overwritten by the next run rather than
 * accumulating.
 *
 * @param fixtureName Directory name under the workspace root. Prefix it with
 * `__` so it sorts away from real projects and never becomes the DEFAULT
 * project (`listStudioProjects` sorts by display name and `defaultProjectDir`
 * takes the first).
 */
export function createAuthoredFixtureProject(
  fixtureName: string,
  files: Readonly<Record<string, string>>,
): FixtureProject {
  const dir = path.join(WORKSPACE_ROOT, fixtureName)
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents, 'utf8')
  }
  return { dir, ready: true }
}

export function removeFixtureProject(fixture: FixtureProject): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(fixture.dir, { recursive: true, force: true })
      return
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  console.warn(`[studioFixtureProject] could not remove ${fixture.dir} — a process still holds it open.`)
}

/** The three `.studio/meta.json` fields the trust-tier contract is written in. */
export interface FixtureTrustMeta {
  /** Absent means Tier 0 — `trustTier.ts` defaults a missing field to `static`. */
  trust?: string
  /** True when the promotion's ORIGIN was Studio rather than a click. */
  trustAutoPromoted?: boolean
  /** Epoch ms of the ONE automatic promotion. Its presence is the latch. */
  trustAutoPromotedAt?: number
}

/**
 * Read the fixture's trust fields straight off disk.
 *
 * Deliberately the FILE and not the `/trust-tier` route: the route is the thing
 * under test, and a gate that has stopped writing the latch would still report
 * whatever it holds in memory. `.studio/meta.json` is where the once-only
 * promise actually lives across a reload.
 */
export function readFixtureTrustMeta(fixture: FixtureProject): FixtureTrustMeta {
  const metaPath = path.join(fixture.dir, '.studio', 'meta.json')
  if (!fs.existsSync(metaPath)) return {}
  const raw: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  return {
    trust: typeof record.trust === 'string' ? record.trust : undefined,
    trustAutoPromoted: typeof record.trustAutoPromoted === 'boolean' ? record.trustAutoPromoted : undefined,
    trustAutoPromotedAt:
      typeof record.trustAutoPromotedAt === 'number' ? record.trustAutoPromotedAt : undefined,
  }
}

/**
 * Point the browser at the fixture project and wait for its board.
 *
 * `autoSave` is a parameter rather than a constant because the two halves of
 * this dogfood want opposite things: the structural cases want the ONLY writes
 * to be the ones they drive, while the save-chip case needs the autosave path
 * alive so it can be made to fail.
 */
export async function openFixtureBoard(
  page: Page,
  fixture: FixtureProject,
  options: { autoSave: boolean },
): Promise<Locator> {
  await page.addInitScript(
    ({ dir, autoSave }: { dir: string; autoSave: boolean }) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
      window.localStorage.setItem('studio-editor-prefs', JSON.stringify({ autoSave }))
    },
    { dir: fixture.dir, autoSave: options.autoSave },
  )

  await page.goto('/admin/site?studio')
  const canvasRoot = page.getByTestId('canvas-root')
  await expect(canvasRoot).toBeVisible({ timeout: 60_000 })
  await expect(
    page.locator('[data-page-id]').first(),
    'the fixture board rendered no frames at all',
  ).toBeAttached({ timeout: 90_000 })

  // Reset the view with the product's own Ctrl+0 before anything pans. The
  // canvas's "center on open" pass races the arrival of the page documents it
  // centres on, so on a cold load the board can settle pointed somewhere with
  // no frame in it — and no amount of waiting fixes a view that is simply
  // aimed elsewhere.
  //
  // Nothing here waits for a MOUNTED iframe: frames are virtualized, and which
  // one mounts is decided by where the viewport ends up. `frameForPage` pans to
  // the frame a case actually wants and waits for that one, which is both more
  // precise and not a race.
  await canvasRoot.focus()
  await page.keyboard.press('Control+0')
  await page.waitForTimeout(800)
  return canvasRoot
}

/**
 * Pan the board until `target` sits near the canvas centre.
 *
 * Same mechanism `canvas-deselect.e2e.ts` / `frame-fit-height.e2e.ts` use: the
 * canvas has no scroll container, so `locator.scrollIntoViewIfNeeded()` can
 * never move it.
 */
export async function panIntoView(
  page: Page,
  canvasRoot: Locator,
  target: Locator,
  tolerancePx = 40,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox) throw new Error('panIntoView: the canvas root has no bounding box')
    if (!targetBox) throw new Error('panIntoView: target has no bounding box')

    const rootCenterX = rootBox.x + rootBox.width / 2
    const rootCenterY = rootBox.y + rootBox.height / 2
    const dx = targetBox.x + targetBox.width / 2 - rootCenterX
    const dy = targetBox.y + targetBox.height / 2 - rootCenterY
    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootCenterX, rootCenterY)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target never reached the viewport center after 8 pan attempts')
}

/**
 * Bring one specific board frame on screen and wait for it to mount a live
 * canvas iframe. `pageId` is the `data-page-id` the board frame carries — the
 * same id `.studio/boards.json` stores.
 *
 * Needed wherever a case depends on WHICH page it is editing (a page with
 * literal text, say), since frames are virtualized and `.first()` is decided
 * by board geometry, not by the spec.
 */
export async function frameForPage(page: Page, canvasRoot: Locator, pageId: string): Promise<Locator> {
  const frame = page.locator(`[data-page-id="${cssEscape(pageId)}"]`).first()
  await expect(frame, `the fixture board has no frame for page "${pageId}"`).toBeAttached({
    timeout: 30_000,
  })
  await panIntoView(page, canvasRoot, frame)
  await expect(
    frame.locator(CANVAS_FRAME_IFRAME_SELECTOR),
    `the "${pageId}" frame never mounted a live canvas iframe after being panned into view`,
  ).toBeVisible({ timeout: 60_000 })
  return frame
}

/**
 * Click an element rendered INSIDE a canvas iframe with real mouse
 * coordinates. `locator.click()`'s actionability wants to scroll the element
 * into view and the canvas pans via a CSS transform, so it would hang.
 */
export async function clickInFrame(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 })
  const box = await target.boundingBox()
  expect(box, 'click target has no bounding box').not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

/**
 * The parsed children of one element inside a frame, in document order, as
 * `[data-node-id]` locators. Only DIRECT `[data-node-id]` descendants count —
 * a grandchild is a different parent's sibling set.
 */
export async function nodeChildIds(contentFrame: FrameLocator, parentNodeId: string): Promise<string[]> {
  return contentFrame
    .locator(`[data-node-id="${cssEscape(parentNodeId)}"]`)
    .first()
    .evaluate((parent) => {
      const out: string[] = []
      const walk = (element: Element) => {
        for (const child of Array.from(element.children)) {
          const id = child.getAttribute('data-node-id')
          if (id) out.push(id)
          else walk(child)
        }
      }
      walk(parent)
      return out
    })
}

export interface SiblingRun {
  /** The container the run lives in. */
  parentId: string
  /** The run, in document order. Contiguous siblings of `parentId`. */
  childIds: string[]
  /** `gapsPx[i]` is the visible space between `childIds[i]` and `childIds[i + 1]`. */
  gapsPx: number[]
}

/**
 * The longest run of ADJACENT siblings inside a live frame that this dogfood
 * can drive, chosen by what the elements are rather than by a class name — so
 * an edit to the fixture project cannot silently retarget a spec at the page
 * root.
 *
 * Four constraints, each of them load-bearing:
 *
 *  1. **Plain source ids only** (`rel:line:col`, no `~` and no `#`). A
 *     composite id belongs to a LOCAL COMPONENT that `inlineLocalComponents`
 *     spliced into the page — its last segment names the component's own file
 *     while the gesture writes the CALL SITE's file, so a spec reading "the
 *     file this node writes to" would read the wrong one. A `#` suffix is a
 *     `.map` row, which every structural gesture refuses by design.
 *  2. **Leaves** (no `[data-node-id]` descendant), because `NodeRenderer`
 *     selects the INNERMOST node under the cursor. Clicking the centre of a
 *     container selects whatever child happens to be there — measured, not
 *     theorised: the first run of this spec duplicated a grandchild while
 *     asserting about its grandparent's source position.
 *  3. **Contiguous**, because ⌘G refuses a non-contiguous selection
 *     (`struct-10`) and this dogfood is about the gesture succeeding.
 *  4. **Clickable, and not an authored form control.**
 *     `useCanvasFormControlSuppression` installs a capture-phase `pointerdown`
 *     listener in every frame that calls `preventDefault()` on any press
 *     landing in `input, textarea, select, button` — deliberately, so a press
 *     selects the node instead of activating the user's control. The drag
 *     trigger's first line is `if (event.defaultPrevented) return`, so a press
 *     on one of those can never open a drag session. That is the product
 *     working; it just makes form controls unrepresentative drag targets.
 *
 * Returns the container with the MOST such children, so a caller that needs
 * three (a drag past a neighbour) and a caller that needs two (a group) agree
 * on one target rather than each finding its own.
 */
export async function findSiblingRun(
  contentFrame: FrameLocator,
  options: { minCount?: number } = {},
): Promise<SiblingRun> {
  const minCount = options.minCount ?? 2
  const found = await contentFrame.locator('body').evaluate((_body, min: number) => {
    const PLAIN_SOURCE_ID = /^[^~#]+:\d+:\d+$/
    const AUTHORED_FORM_CONTROL = 'input, textarea, select, button, option, optgroup'
    const rectOf = (element: Element) => element.getBoundingClientRect()
    const usable = (element: Element) => {
      const id = element.getAttribute('data-node-id') ?? ''
      if (!PLAIN_SOURCE_ID.test(id)) return false
      if (element.querySelector('[data-node-id]')) return false
      if (element.matches(AUTHORED_FORM_CONTROL)) return false
      const rect = rectOf(element)
      return rect.width >= 12 && rect.height >= 12
    }
    const directNodeChildren = (element: Element): Element[] => {
      const out: Element[] = []
      const walk = (current: Element) => {
        for (const child of Array.from(current.children)) {
          if (child.hasAttribute('data-node-id')) out.push(child)
          else walk(child)
        }
      }
      walk(element)
      return out
    }
    const gapBetween = (a: Element, b: Element) => {
      const ra = rectOf(a)
      const rb = rectOf(b)
      const horizontal = Math.max(rb.left - ra.right, ra.left - rb.right, 0)
      const vertical = Math.max(rb.top - ra.bottom, ra.top - rb.bottom, 0)
      return Math.max(horizontal, vertical)
    }

    let best: { parentId: string; childIds: string[]; gapsPx: number[] } | null = null
    for (const parent of Array.from(document.querySelectorAll('[data-node-id]'))) {
      const children = directNodeChildren(parent).filter(usable)
      if (children.length < min) continue
      if (best && children.length <= best.childIds.length) continue
      best = {
        parentId: parent.getAttribute('data-node-id')!,
        childIds: children.map((child) => child.getAttribute('data-node-id')!),
        gapsPx: children.slice(1).map((child, i) => gapBetween(children[i]!, child)),
      }
    }
    return best
  }, minCount)

  if (!found) {
    throw new Error(
      `the frame rendered no container with ${minCount} adjacent, source-addressable, clickable leaf children — ` +
        "every gesture in this dogfood needs a real sibling run, and one that writes to the open page's own file",
    )
  }
  return found
}

/**
 * A leaf node inside a frame: the deepest `[data-node-id]` with no
 * `[data-node-id]` descendant that renders at a clickable size.
 */
export async function firstLeafNode(contentFrame: FrameLocator): Promise<Locator> {
  const candidates = contentFrame.locator('[data-node-id]:not(:has([data-node-id]))')
  await expect(
    candidates.first(),
    'the fixture frame rendered no leaf [data-node-id] element',
  ).toBeVisible({ timeout: 30_000 })

  const count = await candidates.count()
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i)
    const box = await candidate.boundingBox().catch(() => null)
    if (box && box.width >= 12 && box.height >= 12) return candidate
  }
  throw new Error('firstLeafNode: no leaf node in the frame is large enough to click')
}

// ─── Source-of-truth reads ───────────────────────────────────────────────────

export interface SourceNodeLocation {
  /** Project-relative file, POSIX-separated, exactly as the id carries it. */
  rel: string
  /** 1-based, as `buildSourceNodeId` mints them. */
  line: number
  col: number
}

/**
 * Decode a studio node id back to the source position it writes to.
 *
 * A deliberate re-statement of `decodeSourceNodeId`'s grammar
 * (`src/core/page-tree/sourceNodeId.ts`) rather than an import: the e2e
 * tsconfig carries no `@core/*` path mapping, and a spec that reached into
 * `src/` would be asserting against the same code it is testing. The two rules
 * that matter are copied verbatim from that module's own doc — split on the
 * composite separator `~` and take the LAST segment, then read `rel:line:col`.
 */
export function decodeNodeSourceLocation(nodeId: string): SourceNodeLocation | null {
  const target = nodeId.split('~').pop() ?? nodeId
  const match = /^(.+):(\d+):(\d+)$/.exec(target)
  if (!match) return null
  return { rel: match[1]!, line: Number(match[2]), col: Number(match[3]) }
}

/** Read the `.tsx` a node id points at, out of the fixture project on disk. */
export function readNodeSourceFile(fixture: FixtureProject, location: SourceNodeLocation): string {
  return fs.readFileSync(path.join(fixture.dir, ...location.rel.split('/')), 'utf8')
}

/**
 * How many times a snippet of source appears in a file, ignoring whitespace
 * shape.
 *
 * This is the honest way to count copies of an element that
 * `duplicateJsxElement` wrote: the codemod re-emits the element's own source
 * text, so a copy is byte-identical to the original apart from the whitespace
 * around it — it may be re-indented, and it may land on the SAME line as the
 * original. Collapsing every whitespace run to one space on both sides is what
 * makes the count survive both, and nothing else about the file is assumed.
 *
 * Callers compare a DELTA (after − before) rather than an absolute, so a
 * fixture that already contains two identical elements is not a problem.
 */
export function countSourceOccurrences(source: string, snippet: string): number {
  const needle = snippet.replace(/\s+/g, ' ').trim()
  if (needle.length === 0) throw new Error('countSourceOccurrences: refusing to count an empty snippet')
  const haystack = source.replace(/\s+/g, ' ')
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
}

/** The 1-based line `location` names, as written in the file. */
export function sourceLineAt(source: string, line: number): string {
  const lines = source.split(/\r?\n/)
  const text = lines[line - 1]
  if (text === undefined) {
    throw new Error(`sourceLineAt: the file has ${lines.length} lines, so line ${line} does not exist`)
  }
  return text
}

// ─── Toast + console recorders ───────────────────────────────────────────────

export interface RecordedToast {
  kind: string
  title: string
  /** The `×N` collapse counter at the moment the card was inserted. */
  repeat: string | null
}

/**
 * Record every toast CARD created from now on.
 *
 * Counting cards at one instant would race the auto-dismiss timer (4 s for
 * non-errors) and the asynchronous writes that push them. A `MutationObserver`
 * counts every card that was ever INSERTED, which is precisely what "the user
 * saw five cards" means. A de-duplicated repeat replaces a toast in place
 * under the same React key and inserts no new node, so this number is the
 * number of distinct cards.
 */
export async function startToastRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const created: Array<{ kind: string; title: string; repeat: string | null }> = []
    const record = (node: Node) => {
      if (!(node instanceof HTMLElement)) return
      const cards = node.matches('[data-toast-kind]')
        ? [node]
        : Array.from(node.querySelectorAll('[data-toast-kind]'))
      for (const card of cards) {
        created.push({
          kind: card.getAttribute('data-toast-kind') ?? 'unknown',
          title: card.textContent?.trim().slice(0, 120) ?? '',
          repeat: card.querySelector('[data-toast-repeat]')?.getAttribute('data-toast-repeat') ?? null,
        })
      }
    }
    const observer = new MutationObserver((records) => {
      for (const mutation of records) mutation.addedNodes.forEach(record)
    })
    observer.observe(document.body, { subtree: true, childList: true })
    window.__studioPhase0ToastLog = { created, observer }
  })
}

/**
 * Stop recording and return every card inserted since `startToastRecorder`,
 * plus the highest `×N` each title reached (read live, because the counter is
 * written onto a card that is already in the DOM).
 */
export async function readToastRecorder(page: Page): Promise<RecordedToast[]> {
  return page.evaluate(() => {
    const log = window.__studioPhase0ToastLog
    if (!log) throw new Error('the toast recorder was never installed')
    log.observer.disconnect()
    delete window.__studioPhase0ToastLog
    const live = Array.from(document.querySelectorAll('[data-toast-kind]'))
    return log.created.map((entry) => {
      const match = live.find((card) => (card.textContent?.trim().slice(0, 120) ?? '') === entry.title)
      return {
        ...entry,
        repeat: match?.querySelector('[data-toast-repeat]')?.getAttribute('data-toast-repeat') ?? entry.repeat,
      }
    })
  })
}

declare global {
  interface Window {
    __studioPhase0ToastLog?: {
      created: Array<{ kind: string; title: string; repeat: string | null }>
      observer: MutationObserver
    }
  }
}

/** One console-error or uncaught-error event, tagged with the case that produced it. */
export interface RecordedConsoleEvent {
  /** `'console.error'` or `'pageerror'`. */
  source: 'console.error' | 'pageerror'
  text: string
  /** The test that was running when it fired. */
  test: string
}

/**
 * Attach the console/pageerror taps for one test. Every event lands in `sink`,
 * tagged with `testName`, so one assertion at the end of the file can report
 * which case produced which noise.
 */
export function recordConsoleErrors(page: Page, sink: RecordedConsoleEvent[], testName: string): void {
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    sink.push({ source: 'console.error', text: message.text(), test: testName })
  })
  page.on('pageerror', (error) => {
    sink.push({ source: 'pageerror', text: `${error.name}: ${error.message}`, test: testName })
  })
}

/** CSS.escape for a value used inside an attribute selector, done in Node. */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

// ─── Whole-project change detection ──────────────────────────────────────────

/**
 * Every file in the fixture, keyed by project-relative POSIX path, valued by a
 * SHA-256 of its bytes. Diffing two of these answers "which files did that
 * change touch" for a directory that is deliberately not a version-controlled
 * repository.
 *
 * `createFixtureProject` copies a tracked corpus into a throwaway name;
 * initialising a repository inside the copy would put a `.git` directory
 * there, which `assertOwnGitRepo` treats as a real project repository and
 * `studio_git_status` would then happily report on. A spec that changes what
 * the agent can see is measuring a different product than the one that ships.
 *
 * What is skipped, and why each one — every entry is something STUDIO writes,
 * not something the user or the agent authored, so counting it would report a
 * change on every run and drown the one that matters. Measured against a real
 * agent turn: all five of these moved while the turn's only authored edit was
 * one stylesheet.
 *   - `node_modules/` — not authored source, and large enough that hashing it
 *     would dominate the spec's runtime.
 *   - `.studio/` — Studio's own sidecar: board geometry, caches, the compiled
 *     framework token file, the agent turn log. Opening the board writes here.
 *   - `.git/` — defence in depth, in case a source corpus ever carries one.
 *   - `.claude/` — the `claude` CLI's own settings plus Studio's
 *     `.studio-generated.json` guide marker, both written when the driver
 *     spawns a session in this directory.
 *   - `CLAUDE.md` — written by `generateStudioProjectGuide()` at CLI spawn.
 *   - `prototype/` — regenerated by the shell scaffolder when the board opens
 *     (`registry.generated.jsx` and friends).
 *
 * Matched by NAME at any depth, not by path: a nested `CLAUDE.md` is skipped
 * too. That is the safe direction — these names are Studio's everywhere.
 */
export function snapshotProjectFiles(fixture: FixtureProject): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (absDir: string, rel: string): void => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (SNAPSHOT_SKIPPED_NAMES.has(entry.name)) continue
      const abs = path.join(absDir, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, childRel)
      else if (entry.isFile()) out.set(childRel, hashFile(abs))
    }
  }
  walk(fixture.dir, '')
  return out
}

const SNAPSHOT_SKIPPED_NAMES = new Set(['node_modules', '.studio', '.git', '.claude', 'CLAUDE.md', 'prototype'])

function hashFile(abs: string): string {
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
}

export interface ProjectFileChanges {
  modified: string[]
  added: string[]
  removed: string[]
}

/**
 * The project-relative paths that differ from `before`, sorted. Added, removed
 * and modified are kept apart so a failure message says which happened — "the
 * agent created a file" and "the agent edited a file" are different findings.
 */
export function changedProjectFiles(
  fixture: FixtureProject,
  before: Map<string, string>,
): ProjectFileChanges {
  const after = snapshotProjectFiles(fixture)
  const modified: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const [rel, hash] of after) {
    const previous = before.get(rel)
    if (previous === undefined) added.push(rel)
    else if (previous !== hash) modified.push(rel)
  }
  for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel)
  return { modified: modified.sort(), added: added.sort(), removed: removed.sort() }
}
