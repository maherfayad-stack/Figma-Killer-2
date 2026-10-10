/**
 * A Chrome DevTools trace around one gesture, split by main-thread task, event
 * kind and (where Chrome records it) frame. This is the attribution tool SB-0
 * of the board-speed plan uses to say WHERE a long task goes instead of
 * guessing.
 *
 * Nothing here asserts. `traceGesture` starts a `devtools.timeline` trace, runs
 * the gesture, stops the trace and returns the summary of the longest
 * main-thread task that started within `windowMs` of the first input event
 * (`pointerdown` / `mousedown` / `wheel`). Event names are the browser's own
 * (`UpdateLayoutTree`, `Layout`, `FunctionCall`, `EventDispatch`, ...).
 */
import type { CDPSession, Page } from '@playwright/test'

interface TraceEvent {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: {
    name?: string
    elementCount?: number
    data?: Record<string, unknown>
    beginData?: Record<string, unknown>
    endData?: Record<string, unknown>
  }
}

export interface KindTotal {
  name: string
  count: number
  totalMs: number
  /** Distinct frames (documents) the events were attributed to; 0 when the browser did not record one. */
  frames: number
  elements?: number
}

export interface LongTaskReport {
  /** Longest main-thread RunTask starting within the window, ms. */
  longestTaskMs: number
  /** Every RunTask over 16 ms in the window, ms. */
  tasksOver16ms: number[]
  /** Per event kind, summed over the longest task, biggest first. */
  kinds: KindTotal[]
  /** `UpdateLayoutTree` + `Layout` events inside the longest task, per attributed frame id. */
  layoutByFrame: Array<{ frame: string; styleMs: number; layoutMs: number; styleEvents: number; layoutEvents: number }>
  /** Total events the trace held, for sanity. */
  traceEvents: number
}

const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'v8.execute',
  'blink.user_timing',
].join(',')

function frameOf(event: TraceEvent): string {
  const a = event.args
  const frame = a?.beginData?.frame ?? a?.data?.frame ?? a?.endData?.frame
  return typeof frame === 'string' ? frame : ''
}

async function collect(client: CDPSession, run: () => Promise<void>): Promise<TraceEvent[]> {
  const events: TraceEvent[] = []
  client.on('Tracing.dataCollected', (chunk) => {
    // The protocol types a trace event as a string map; the real payload is the Trace Event Format.
    events.push(...(chunk.value as unknown as TraceEvent[]))
  })
  const complete = new Promise<void>((resolve) => client.once('Tracing.tracingComplete', () => resolve()))
  await client.send('Tracing.start', { categories: CATEGORIES, transferMode: 'ReportEvents' })
  await run()
  await client.send('Tracing.end')
  await complete
  return events
}

export function summarizeTrace(events: TraceEvent[], windowMs: number): LongTaskReport {
  // The renderer main thread is the one named CrRendererMain.
  const mainTids = new Set<string>()
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') mainTids.add(`${e.pid}:${e.tid}`)
  }
  const main = events.filter((e) => mainTids.has(`${e.pid}:${e.tid}`) && e.ph === 'X' && typeof e.dur === 'number')
  const inputs = main.filter(
    (e) => e.name === 'EventDispatch' && ['pointerdown', 'mousedown', 'wheel'].includes(String(e.args?.data?.type)),
  )
  const start = inputs.length > 0 ? Math.min(...inputs.map((e) => e.ts)) : Number.NEGATIVE_INFINITY
  const end = start + windowMs * 1000
  const tasks = main.filter((e) => e.name === 'RunTask' && e.ts + (e.dur ?? 0) >= start && e.ts <= end)
  const longest = tasks.reduce<TraceEvent | null>((best, t) => (!best || (t.dur ?? 0) > (best.dur ?? 0) ? t : best), null)
  const report: LongTaskReport = {
    longestTaskMs: longest ? (longest.dur ?? 0) / 1000 : 0,
    tasksOver16ms: tasks.filter((t) => (t.dur ?? 0) > 16_000).map((t) => (t.dur ?? 0) / 1000),
    kinds: [],
    layoutByFrame: [],
    traceEvents: events.length,
  }
  if (!longest) return report
  const lo = longest.ts
  const hi = longest.ts + (longest.dur ?? 0)
  const inside = main.filter((e) => e !== longest && e.ts >= lo && e.ts + (e.dur ?? 0) <= hi)
  const byKind = new Map<string, { count: number; us: number; frames: Set<string>; elements: number }>()
  const byFrame = new Map<string, { styleUs: number; layoutUs: number; styleEvents: number; layoutEvents: number }>()
  for (const e of inside) {
    const k = byKind.get(e.name) ?? { count: 0, us: 0, frames: new Set<string>(), elements: 0 }
    k.count += 1
    k.us += e.dur ?? 0
    const frame = frameOf(e)
    if (frame) k.frames.add(frame)
    if (typeof e.args?.elementCount === 'number') k.elements += e.args.elementCount
    byKind.set(e.name, k)
    if (e.name === 'UpdateLayoutTree' || e.name === 'Layout') {
      const key = frame || '(unattributed)'
      const f = byFrame.get(key) ?? { styleUs: 0, layoutUs: 0, styleEvents: 0, layoutEvents: 0 }
      if (e.name === 'Layout') {
        f.layoutUs += e.dur ?? 0
        f.layoutEvents += 1
      } else {
        f.styleUs += e.dur ?? 0
        f.styleEvents += 1
      }
      byFrame.set(key, f)
    }
  }
  report.kinds = [...byKind.entries()]
    .map(([name, k]) => ({ name, count: k.count, totalMs: k.us / 1000, frames: k.frames.size, elements: k.elements || undefined }))
    .sort((a, b) => b.totalMs - a.totalMs)
  report.layoutByFrame = [...byFrame.entries()]
    .map(([frame, f]) => ({ frame, styleMs: f.styleUs / 1000, layoutMs: f.layoutUs / 1000, styleEvents: f.styleEvents, layoutEvents: f.layoutEvents }))
    .sort((a, b) => b.styleMs + b.layoutMs - (a.styleMs + a.layoutMs))
  return report
}

/** Run `gesture` under a DevTools trace and report on the longest task within `windowMs` of its first input. */
export async function traceGesture(page: Page, gesture: () => Promise<void>, windowMs = 400): Promise<LongTaskReport> {
  const client = await page.context().newCDPSession(page)
  try {
    const events = await collect(client, gesture)
    return summarizeTrace(events, windowMs)
  } finally {
    await client.detach()
  }
}

export interface MainThreadTasks {
  /** Every main-thread RunTask that started during the action, longest first, ms. */
  tasksMs: number[]
  longestMs: number
  totalMs: number
}

/** Run `action` under a DevTools trace and report every main-thread task it produced (no input event needed). */
export async function traceMainThreadTasks(page: Page, action: () => Promise<void>): Promise<MainThreadTasks> {
  const client = await page.context().newCDPSession(page)
  try {
    const events = await collect(client, action)
    const mainTids = new Set<string>()
    for (const e of events) {
      if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') mainTids.add(`${e.pid}:${e.tid}`)
    }
    const tasksMs = events
      .filter((e) => mainTids.has(`${e.pid}:${e.tid}`) && e.ph === 'X' && e.name === 'RunTask' && typeof e.dur === 'number')
      .map((e) => (e.dur ?? 0) / 1000)
      .sort((a, b) => b - a)
    return { tasksMs, longestMs: tasksMs[0] ?? 0, totalMs: tasksMs.reduce((sum, ms) => sum + ms, 0) }
  } finally {
    await client.detach()
  }
}

export interface DomCounters {
  documents: number
  nodes: number
  jsEventListeners: number
}

/** `Memory.getDOMCounters` after a forced GC, so a detached-but-collectable document does not count. */
export async function readDomCounters(page: Page): Promise<DomCounters> {
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('HeapProfiler.collectGarbage')
    await client.send('HeapProfiler.collectGarbage')
    return (await client.send('Memory.getDOMCounters')) as DomCounters
  } finally {
    await client.detach()
  }
}

export interface CpuHotspot {
  /** `functionName @ file:line` (the bundle is minified in preview, so the file chunk is the module hint). */
  where: string
  selfMs: number
}

export interface CpuProfileReport {
  totalMs: number
  /** Self time by function, biggest first. */
  hotspots: CpuHotspot[]
  /** Self time summed per script file: which module chunk the click's JS lives in. */
  byFile: Array<{ file: string; selfMs: number }>
}

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}

/** A V8 sampling CPU profile around `gesture`, aggregated by function and by script file. */
export async function profileCpu(page: Page, gesture: () => Promise<void>, top = 25): Promise<CpuProfileReport> {
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Profiler.enable')
    await client.send('Profiler.setSamplingInterval', { interval: 100 })
    await client.send('Profiler.start')
    await gesture()
    const { profile } = (await client.send('Profiler.stop')) as {
      profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }
    }
    const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
    const selfUs = new Map<number, number>()
    profile.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
    const byFn = new Map<string, number>()
    const byFile = new Map<string, number>()
    let total = 0
    for (const [id, us] of selfUs) {
      const node = nodeById.get(id)
      if (!node) continue
      const { functionName, url, lineNumber } = node.callFrame
      if (functionName === '(idle)' || functionName === '(program)') continue
      const file = url.split('/').pop()?.split('?')[0] || functionName
      total += us
      byFn.set(`${functionName || '(anonymous)'} @ ${file}:${lineNumber}`, (byFn.get(`${functionName || '(anonymous)'} @ ${file}:${lineNumber}`) ?? 0) + us)
      byFile.set(file, (byFile.get(file) ?? 0) + us)
    }
    return {
      totalMs: total / 1000,
      hotspots: [...byFn.entries()].map(([where, us]) => ({ where, selfMs: us / 1000 })).sort((a, b) => b.selfMs - a.selfMs).slice(0, top),
      byFile: [...byFile.entries()].map(([file, us]) => ({ file, selfMs: us / 1000 })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 12),
    }
  } finally {
    await client.detach()
  }
}
