/**
 * studioGrants — the `.studio/` state that GRANTS something, and the rule
 * that a repository can never supply it.
 *
 * `.studio/` lives inside the user's repository, so its files arrive the way
 * any file does: with a clone, a pull, a branch switch, a conflict resolved
 * to "theirs". Most of them are harmless to take from a repository (a board,
 * review threads, prototype links). A few are not, because they are
 * decisions only this server's owner may make:
 *
 * - **Share state** — `.studio/shares.json` and the snapshots under
 *   `.studio/shares/`. A record there makes `/share/<token>` serve the
 *   project to anyone holding the token. A repository's records are someone
 *   else's tokens: kept, they turn the original owner's (or an attacker's)
 *   links live on this server, serving this user's board.
 * - **Grant fields in `.studio/meta.json`** ({@link STUDIO_META_GRANT_FIELDS}) —
 *   the trust tier, and which MCP servers are approved to run (with the
 *   definitions of the Studio-registered ones). A repository that sets
 *   `trust` back to `run-project` after the owner chose `static`, or approves
 *   a server by name, is granting itself code execution.
 *
 * On a clone none of it survives: `gitClone.ts` replaces the repository's
 * `meta.json` outright, and removes its share state. (The zipball and upload
 * imports drop every `.studio/` entry — `archiveIngest.ts`.) This module is
 * the rule for everything AFTER that:
 *
 * **A git verb raises no grant** ({@link withStudioGrantsPinned}, wrapped
 * around every Studio git verb by `gitOperations.ts`'s `withGitWriteLock`):
 * the grants are read before the verb, and after it each one is put to the
 * LESSER of before and after ({@link lesserGrants}). Not "exactly what it
 * was": the trust and approval routes do not hold the project write lock,
 * so an owner who lowers the tier while a long pull runs must keep that.
 * What a verb can never do is leave a grant higher than it found it — a
 * tier raised or a deleted `meta.json` (absent `trust` is the default,
 * `run-project`), a server approved, a registered server's definition
 * swapped under an approved name. Share state a verb touched in any way is
 * dropped, every link with it — the server can no longer vouch for what
 * any token would serve. `.studio/` is made link-free after the verb as it
 * is after a clone (`stripStudioStoreLinks`), because a pulled
 * `.studio -> elsewhere` would make every record read as absent.
 *
 * A lowering shows in `git status` as a local change to `.studio/meta.json`
 * (or a deleted `shares.json`), and Studio will not pull over it until it is
 * committed or discarded. That is the honest outcome: the repository's value
 * was refused, and the user can see which file it was in. A `meta.json` a
 * verb left unreadable (conflict markers) reads as no grants at all, i.e. the
 * default tier; if that is higher than before, the file is rewritten with the
 * lowered grants and whatever else of it Studio could not read is lost — the
 * conflict is still in git's index, and resolving it re-runs this rule.
 */
import { dropAllShareState, shareStateFingerprint } from './shareStore'
import { DEFAULT_TRUST_TIER, readStudioMeta, writeStudioMeta, type StudioMeta, type TrustTier } from './studioMeta'
import { stripStudioStoreLinks } from './studioStore'

/** The `meta.json` fields that grant something. Everything else in the file is a preference, a cache or a layout. */
export const STUDIO_META_GRANT_FIELDS = [
  'trust',
  'approvedMcpServers',
  'registeredMcpServers',
  'approvedRegisteredMcpServers',
] as const satisfies readonly (keyof StudioMeta)[]

type StudioMetaGrants = Pick<StudioMeta, (typeof STUDIO_META_GRANT_FIELDS)[number]>

/** The grants a project holds at one moment, for {@link reassertStudioGrants}. */
export interface StudioGrantPin {
  readonly meta: StudioMetaGrants
  readonly shares: string
}

function metaGrants(meta: StudioMeta): StudioMetaGrants {
  const grants: StudioMetaGrants = {}
  for (const field of STUDIO_META_GRANT_FIELDS) {
    if (meta[field] !== undefined) Object.assign(grants, { [field]: meta[field] })
  }
  return grants
}

function sameGrants(a: StudioMetaGrants, b: StudioMetaGrants): boolean {
  return STUDIO_META_GRANT_FIELDS.every((field) => JSON.stringify(a[field]) === JSON.stringify(b[field]))
}

/** `meta` with its grant fields replaced by `grants` — a field absent from `grants` is removed. */
function withGrants(meta: StudioMeta, grants: StudioMetaGrants): StudioMeta {
  const next: StudioMeta = { ...meta }
  for (const field of STUDIO_META_GRANT_FIELDS) delete next[field]
  return { ...next, ...grants }
}

const TIER_ORDER: readonly TrustTier[] = ['static', 'render-packages', 'run-project']

/** Names in `now` that were also in `before` — an approval survives only if it was already there. */
function keptNames(now: readonly string[] | undefined, before: readonly string[] | undefined): string[] | undefined {
  if (now === undefined) return undefined
  const allowed = new Set(before ?? [])
  return now.filter((name) => allowed.has(name))
}

/**
 * Each grant in `now` lowered to at most what it was in `before`: the trust
 * tier is the lower of the two (absent reads as the default tier on both
 * sides), an approval survives only if it was approved before too, and a
 * registered server survives only with the exact definition it had before.
 * Whatever `now` holds that is lower than `before` stays as it is.
 */
export function lesserGrants(before: StudioMetaGrants, now: StudioMetaGrants): StudioMetaGrants {
  const next: StudioMetaGrants = { ...now }
  const tierBefore = TIER_ORDER.indexOf(before.trust ?? DEFAULT_TRUST_TIER)
  const tierNow = TIER_ORDER.indexOf(now.trust ?? DEFAULT_TRUST_TIER)
  if (tierNow > tierBefore) next.trust = TIER_ORDER[tierBefore]
  next.approvedMcpServers = keptNames(now.approvedMcpServers, before.approvedMcpServers)
  next.approvedRegisteredMcpServers = keptNames(now.approvedRegisteredMcpServers, before.approvedRegisteredMcpServers)
  if (now.registeredMcpServers !== undefined) {
    const definitionBefore = new Map((before.registeredMcpServers ?? []).map((entry) => [entry.name, JSON.stringify(entry.definition)]))
    next.registeredMcpServers = now.registeredMcpServers.filter((entry) => definitionBefore.get(entry.name) === JSON.stringify(entry.definition))
  }
  for (const field of STUDIO_META_GRANT_FIELDS) {
    if (next[field] === undefined) delete next[field]
  }
  return next
}

/** The grants `dir` holds now. */
export function pinStudioGrants(dir: string): StudioGrantPin {
  return { meta: metaGrants(readStudioMeta(dir)), shares: shareStateFingerprint(dir) }
}

/** What {@link reassertStudioGrants} had to undo, for the caller's log. */
export interface ReassertedGrants {
  readonly linksRemoved: boolean
  readonly sharesDropped: boolean
  readonly metaLowered: boolean
}

/** The second half of {@link withStudioGrantsPinned}: lower `dir`'s grants to at most `pin`'s, and drop share state that changed since. Returns what it had to change. */
export function reassertStudioGrants(dir: string, pin: StudioGrantPin): ReassertedGrants {
  const stripped = stripStudioStoreLinks(dir)
  const linksRemoved = stripped.rootReplaced || stripped.removed.length > 0

  const sharesDropped = shareStateFingerprint(dir) !== pin.shares
  if (sharesDropped) dropAllShareState(dir)

  const meta = readStudioMeta(dir)
  const now = metaGrants(meta)
  const lowered = lesserGrants(pin.meta, now)
  const metaLowered = !sameGrants(now, lowered)
  if (metaLowered) writeStudioMeta(dir, withGrants(meta, lowered))

  return { linksRemoved, sharesDropped, metaLowered }
}

/**
 * Run a git verb with the project's grants pinned — read before,
 * lowered back to at most that after, whether the verb succeeded, failed or
 * stopped on a conflict.
 * Call inside the project write lock, so nothing else writes a grant between
 * the two.
 */
export async function withStudioGrantsPinned<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const pin = pinStudioGrants(dir)
  try {
    return await run()
  } finally {
    const undone = reassertStudioGrants(dir, pin)
    if (undone.linksRemoved || undone.sharesDropped || undone.metaLowered) {
      console.warn(
        `[studio/grants] a git operation changed state that grants access; put back:${undone.linksRemoved ? ' links in .studio removed;' : ''}${undone.sharesDropped ? ' every share link revoked;' : ''}${undone.metaLowered ? ' trust tier and MCP approvals lowered to what they were;' : ''}`,
      )
    }
  }
}
