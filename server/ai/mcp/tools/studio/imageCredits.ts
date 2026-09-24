/**
 * imageCredits — the project's `IMAGE-CREDITS.md`: who made each stock photo
 * the assistant landed, where it came from, and under which licence (P4-E,
 * AI-13).
 *
 * ## Why a file in the repo
 *
 * Attribution has to live where the USER can see it, and it has to travel with
 * the image. A row in Studio's database or a note under `.studio/` fails both:
 * neither is something the user opens, and neither ships when they download
 * the code or push the repo. A markdown file at the project root is read by
 * people, rendered by every git host, and goes wherever the images go. One
 * line per image, keyed by the image's project-relative path, so
 * `studio_list_assets` can show the credit next to the file and the user can
 * delete the line with the image.
 *
 * ## Written like any agent write
 *
 * Through `resolveAgentFilePath(…, 'write')` (the one agent write gate) and
 * `commitPlannedWrites` (hard-link refusal, turn log, live reload), under the
 * project write lock the landing already holds. Appended, never rewritten: a
 * line the user edited is theirs, and an image already credited is not
 * credited twice.
 *
 * ## Untrusted text
 *
 * A photographer's name comes from the provider's API, so it is treated as
 * hostile markdown: link and emphasis syntax, backticks, angle brackets and
 * line breaks are removed, and it is capped. A link is written only for a URL
 * on the provider's own site.
 */
import { toolRefusal, type ToolRefusal } from '@core/ai'
import type { ToolContext } from '../../../runtime/types'
import { resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'
import { readTextCapped } from '../../../../handlers/studio/cappedFileRead'
import { join } from 'node:path'
import { commitPlannedWrites, currentText, isRefusal } from './agentWriteSupport'

/** The credits file, at the project root. */
export const IMAGE_CREDITS_FILE = 'IMAGE-CREDITS.md'

const CREDITS_READ_CAP_BYTES = 512 * 1024

const HEADER = `# Image credits

Stock photos added to this project by Studio's assistant, and who made them. One line per image; delete the line when you delete the image.
`

export interface ImageCredit {
  /** The landed file, project-relative POSIX. */
  readonly relPath: string
  readonly photographer: string
  readonly photographerUrl: string
  readonly sourceLabel: string
  readonly sourceUrl: string
  readonly licenceName: string
  readonly licenceUrl: string
}

/** A name from an API, made inert as markdown: no link/emphasis/code syntax, no HTML, one line, capped. */
function plainText(raw: string): string {
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/[[\]()`*_<>|\\#]/g, '').replace(/\s{2,}/g, ' ').trim()
  return (cleaned.length > 0 ? cleaned : 'Unknown').slice(0, 120)
}

/** `[text](url)` only for an https URL on `allowedHost` (or a subdomain of it); plain text otherwise. */
function link(text: string, rawUrl: string, allowedHost: string): string {
  try {
    const url = new URL(rawUrl)
    const hostOk = url.hostname === allowedHost || url.hostname.endsWith(`.${allowedHost}`)
    if (url.protocol === 'https:' && hostOk && !/[\s()<>]/.test(url.href)) return `[${text}](${url.href})`
  } catch {
    // Not a URL: the name alone is still a credit.
  }
  return text
}

/** The line one credit renders to. `siteHost` is the provider's own site, the only host a link may point at. */
export function creditLine(credit: ImageCredit, siteHost: string): string {
  const who = link(plainText(credit.photographer), credit.photographerUrl, siteHost)
  const where = link(plainText(credit.sourceLabel), credit.sourceUrl, siteHost)
  return `- \`${credit.relPath}\` — Photo by ${who} on ${where} · ${plainText(credit.licenceName)} (${credit.licenceUrl})`
}

const CREDIT_LINE_RE = /^- `([^`\n]+)` — (.+)$/gm

/** Every credited image in the project: relPath → the credit text after the dash. Empty when there is no file. */
export function readImageCredits(dir: string): Map<string, string> {
  const credits = new Map<string, string>()
  const text = readTextCapped(join(dir, IMAGE_CREDITS_FILE), CREDITS_READ_CAP_BYTES)
  if (text === undefined) return credits
  for (const match of text.matchAll(CREDIT_LINE_RE)) credits.set(match[1]!, match[2]!.trim())
  return credits
}

/**
 * Append a line for each credit whose image has none yet. Call inside
 * `withProjectWriteLock` (the landing holds it; the lock is reentrant).
 * Returns the refusal when the file cannot be written, `null` otherwise.
 */
export function recordImageCredits(dir: string, ctx: ToolContext, credits: readonly ImageCredit[], siteHost: string): ToolRefusal | null {
  if (credits.length === 0) return null
  const target = resolveAgentFilePath(dir, IMAGE_CREDITS_FILE, 'write')
  if (!target.ok) return toolRefusal(target.code, target.message, { remedy: target.remedy })
  const current = currentText(target, undefined)
  if (isRefusal(current)) return current
  const original = current.content ?? ''
  const credited = new Set([...original.matchAll(CREDIT_LINE_RE)].map((match) => match[1]!))
  const lines = credits.filter((credit) => !credited.has(credit.relPath)).map((credit) => creditLine(credit, siteHost))
  if (lines.length === 0) return null
  const base = original.length === 0 ? HEADER : original.endsWith('\n') ? original : `${original}\n`
  const next = `${base}${original.length === 0 ? '\n' : ''}${lines.join('\n')}\n`
  const committed = commitPlannedWrites(dir, ctx, [{ target, original, next }])
  return isRefusal(committed) ? committed : null
}
