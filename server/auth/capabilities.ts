/**
 * Server-side capabilities + role module.
 *
 * The capability surface itself (the `CORE_CAPABILITIES` list and the derived
 * `CoreCapability` type) is owned by `@core/capabilities` — the single source
 * of truth shared by client and server. This file imports that list and adds
 * the server-only concerns: the built-in system roles, the boot-time force-sync
 * set, and the runtime capability guards. Both are re-exported so server code
 * has one import site for "everything capabilities".
 *
 * See docs/reference/capabilities.md for the full per-capability reference.
 */
import { CORE_CAPABILITIES, type CoreCapability } from '@core/capabilities'


export type { CoreCapability }

interface SystemRoleDefinition {
  id: string
  slug: string
  name: string
  description: string
  capabilities: CoreCapability[]
}

/**
 * The four built-in system roles.
 *
 * - **Owner** is force-resynced from `CORE_CAPABILITIES` on every boot via
 *   `syncSystemRoles(db)` so adding a new capability never strands an
 *   existing Owner on a stale grant list.
 *
 * - **Admin** is *also* force-resynced from its explicit literal list on
 *   every boot. The list is intentionally written out (not derived by
 *   filtering CORE_CAPABILITIES) so every new capability requires a
 *   conscious decision per PR about whether Admin gets it. This stops
 *   the previous silent-drift bug where new caps silently appeared on
 *   Admin or never appeared at all.
 *
 * - **Client** and **Member** are seeded once and freely editable.
 */
const adminCapabilities: CoreCapability[] = [
  'dashboard.read',
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'pages.edit',
  'pages.publish',
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
  'media.read',
  'media.write',
  'media.replace',
  'media.delete',
  'runtime.dependencies',
  'storage.elect',
  'storage.migrate',
  'plugins.read',
  'plugins.configure',
  'plugins.install',
  'plugins.lifecycle',
  'users.manage',
  // `roles.manage` is owner-only by design — admin cannot grant capabilities.
  'audit.read',
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'data.system.tables.manage',
  'data.rows.move',
  'data.export',
  'data.import',
  'ai.chat',
  'ai.tools.write',
  'ai.providers.manage',
  'ai.audit.read',
  // Studio is the product, so an Admin who cannot create or edit a screen is
  // a broken role, not a safe one. `studio.write` was added to
  // CORE_CAPABILITIES — which Owner receives wholesale via
  // `[...CORE_CAPABILITIES]` — but never added here, so every Studio write
  // tool (`studio_create_page`, `studio_apply_edits`, `studio_codemod`,
  // `studio_set_frames`) was filtered out of an Admin's agent toolset by
  // `selectStudioTools`. The agent did not refuse to build; it was handed no
  // tool that could. It looked like caution and was missing permission.
  //
  // `studio.run.project` IS granted, and that is a deliberate reversal
  // (STUDIO-FIGMA-FEEL-PLAN.md A10, §6 decision 1). It used to be withheld
  // here, which made `studio_render_reference` — the only tool in the whole
  // toolset that validates a screen against the project ACTUALLY RUNNING,
  // rather than against Studio's static parse — unreachable for every real
  // operator, while the prompt happily described it. "Done" could only ever
  // be checked against the parse.
  //
  // What makes granting it safe is that it is no longer the only gate. The
  // capability answers "may this operator run project code at all"; the
  // project's OWN `.studio/meta.json` trust tier answers "may THIS project be
  // run", and every Tier-2 tool now checks both — `referenceRender.ts` calls
  // `checkTrustTier(dir, 'run-project')` exactly as the `/admin/api/studio/
  // dev-server` route does (`handlers/studio/trustGate.ts`). Nothing executes
  // until a human has deliberately promoted that specific project, which is
  // the consent click Tier 2 was always built around. Before A10 the MCP tool
  // had only the capability and the HTTP route had only the tier, so the tool
  // was strictly the weaker of the two — `sec-05` finding 1.
  //
  // `studio.git.write` (W4-3) is deliberately NOT granted either, for the
  // adjacent reason: a commit carries the user's git identity into a history
  // their team reads, and delegating file WRITES to an agent is not the same
  // decision as delegating attribution. A human in the Version control panel
  // is unaffected — that surface is gated by `site.structure.edit` like every
  // other editing panel, not by this capability, which exists to gate the
  // AGENT tool (`studio_git_commit`). Grant it per connector, or on a custom
  // role, when that delegation is actually wanted.
  'studio.write',
  'studio.run.project',
]

const clientCapabilities: CoreCapability[] = [
  'dashboard.read',
  'site.read',
  'site.content.edit',
  // Client needs to browse the media library to swap images on existing
  // nodes (`site.content.edit` already lets them change image src; this
  // makes the picker actually usable).
  'media.read',
  // Data workspace = read-only browsing of CUSTOM tables only. The client
  // never sees the internal system tables (posts/pages/components/layouts).
  'data.custom.tables.read',
]

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    id: 'owner',
    slug: 'owner',
    name: 'Owner',
    description: 'Permanent installation owner with full system access.',
    capabilities: [...CORE_CAPABILITIES],
  },
  {
    id: 'admin',
    slug: 'admin',
    name: 'Admin',
    description: 'Full admin access (cannot manage roles).',
    capabilities: adminCapabilities,
  },
  {
    id: 'client',
    slug: 'client',
    name: 'Client',
    description: 'Can edit page copy (text, images, links) but not structure or styles.',
    capabilities: clientCapabilities,
  },
  {
    id: 'member',
    slug: 'member',
    name: 'Member',
    description: 'Public-facing member account — no admin access by default.',
    capabilities: [],
  },
]

/**
 * The Owner role id is the well-known constant the boot-time sync targets.
 */
export const OWNER_ROLE_ID = 'owner'

/**
 * The Admin role id — also boot-resynced (see `SYSTEM_ROLES` comment).
 * Internal-only: consumed by `FORCE_SYNC_ROLE_IDS` below.
 */
const ADMIN_ROLE_ID = 'admin'

/**
 * Role ids that get their capability list force-synced from code on every
 * boot. Owner and Admin are managed by the system; Client and Member are
 * seeded once and freely editable.
 */
export const FORCE_SYNC_ROLE_IDS: readonly string[] = [OWNER_ROLE_ID, ADMIN_ROLE_ID]

export function isCoreCapability(value: unknown): value is CoreCapability {
  return typeof value === 'string' && CORE_CAPABILITIES.includes(value as CoreCapability)
}

export function normalizeCapabilities(value: unknown): CoreCapability[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<CoreCapability>()
  for (const item of value) {
    if (isCoreCapability(item)) seen.add(item)
  }
  return [...seen].sort((a, b) => CORE_CAPABILITIES.indexOf(a) - CORE_CAPABILITIES.indexOf(b))
}

export function roleHasCapability(capabilities: readonly CoreCapability[], capability: CoreCapability): boolean {
  return capabilities.includes(capability)
}
