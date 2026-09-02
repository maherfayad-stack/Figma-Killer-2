import type { DataTable } from '@core/data/schemas'
import type { CmsCurrentUser } from '@core/persistence'
import type { CoreCapability } from '@core/capabilities'
import type { AdminWorkspace } from './workspace'

// Any-of gate for saving the draft site: holding at least one lets the user
// save in some form; granular diff validation enforces which kinds of changes
// are actually allowed. Mirrors the server gate in handlers/cms/site.ts.
const SITE_WRITE_CAPABILITIES: CoreCapability[] = [
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
]

const PLUGIN_READ_CAPABILITIES: CoreCapability[] = [
  'plugins.read',
  'plugins.configure',
  'plugins.install',
  'plugins.lifecycle',
]

const RUNTIME_STORAGE_CAPABILITIES: CoreCapability[] = [
  'runtime.dependencies',
  'storage.elect',
  'storage.migrate',
]

export function hasCapability(user: CmsCurrentUser | null, capability: CoreCapability): boolean {
  return Boolean(user?.capabilities.includes(capability))
}

function hasAnyCapability(user: CmsCurrentUser | null, capabilities: readonly CoreCapability[]): boolean {
  return capabilities.some((capability) => hasCapability(user, capability))
}

function hasAllCapabilities(user: CmsCurrentUser | null, capabilities: readonly CoreCapability[]): boolean {
  return capabilities.every((capability) => hasCapability(user, capability))
}

// ---------------------------------------------------------------------------
// Site-editor capability helpers
//
// The editor surfaces three granular capabilities:
//   - site.structure.edit  — DnD, add/remove/move/rename nodes, manage pages
//   - site.content.edit    — modify content-typed props (text, image, href)
//   - site.style.edit      — class styles, breakpoints, framework tokens
//
// A user may hold any subset. The editor renders based on which they hold.
// ---------------------------------------------------------------------------

/** Caller can perform structural edits (DnD, add/remove/move nodes, pages). */
export function canEditStructure(user: CmsCurrentUser | null): boolean {
  // Anonymous in tests / SSR is treated as full-access — the gate is the
  // browser's authenticated session, not the absence of a user object.
  if (!user) return true
  return hasAllCapabilities(user, ['site.structure.edit', 'pages.edit'])
}

/** Caller can modify content-typed props on existing nodes. */
export function canEditContent(user: CmsCurrentUser | null): boolean {
  if (!user) return true
  return hasCapability(user, 'site.content.edit')
}

/** Caller can modify CSS classes, style overrides, breakpoints, tokens. */
export function canEditStyle(user: CmsCurrentUser | null): boolean {
  if (!user) return true
  return hasCapability(user, 'site.style.edit')
}

/** Caller can save the draft site in any form (structure + content + style). */
export function canSaveDraftSite(user: CmsCurrentUser | null): boolean {
  if (!user) return true
  return hasAnyCapability(user, SITE_WRITE_CAPABILITIES)
}

// ---------------------------------------------------------------------------
// Data workspace helpers
// ---------------------------------------------------------------------------

/**
 * Whether the caller may SEE a specific table, by family. System tables
 * (`posts`/`pages`/`components`/`layouts`) need a system read cap; custom
 * tables need a custom read cap.
 */
export function canReadTable(user: CmsCurrentUser | null, table: Pick<DataTable, 'system'>): boolean {
  return table.system
    ? hasAnyCapability(user, ['data.system.tables.read', 'data.system.tables.manage'])
    : hasAnyCapability(user, ['data.custom.tables.read', 'data.custom.tables.manage'])
}

/**
 * Whether the caller may MANAGE a specific table's schema. For system tables
 * this only governs custom fields + primary field (identity and built-in fields
 * are immutable for everyone — enforced server-side).
 */
export function canManageTable(user: CmsCurrentUser | null, table: Pick<DataTable, 'system'>): boolean {
  return hasCapability(user, table.system ? 'data.system.tables.manage' : 'data.custom.tables.manage')
}

// ---------------------------------------------------------------------------
// Media workspace helpers
// ---------------------------------------------------------------------------

/** Caller can upload assets and edit metadata. */
export function canWriteMedia(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'media.write')
}

/** Caller can overwrite the bytes of an existing asset. */
export function canReplaceMedia(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'media.replace')
}

/** Caller can soft-delete / purge assets. */
export function canDeleteMedia(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'media.delete')
}

// ---------------------------------------------------------------------------
// Plugin workspace helpers
// ---------------------------------------------------------------------------

/** Caller can open plugin settings and mutate plugin-owned records. */
export function canConfigurePlugins(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'plugins.configure')
}

/** Caller can install, upgrade, uninstall, and re-sync plugin packs. */
export function canInstallPlugins(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'plugins.install')
}

/** Caller can enable, disable, restart, and run/pause/resume schedules. */
export function canManagePluginLifecycle(user: CmsCurrentUser | null): boolean {
  return hasCapability(user, 'plugins.lifecycle')
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

/** Caller can open AI conversations and use read-only AI tools. */
export function canUseAiChat(user: CmsCurrentUser | null): boolean {
  // Layout tests can render outside AdminSessionProvider; keep that preview
  // mode unrestricted. Real authenticated layouts always receive a user.
  if (!user) return true
  return hasCapability(user, 'ai.chat')
}

// ---------------------------------------------------------------------------
// Workspace gating
// ---------------------------------------------------------------------------

/** Caller can see the Users/Roles/Audit panel in Settings. */
export function canAccessUsersWorkspace(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, ['users.manage', 'roles.manage', 'audit.read'])
}

/** Caller can see the AI panel in Settings. */
export function canAccessAiWorkspace(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, ['ai.providers.manage', 'ai.audit.read'])
}

/** Caller can see the Plugins panel in Settings (and plugin-contributed admin pages). */
export function canAccessPluginsWorkspace(user: CmsCurrentUser | null): boolean {
  return hasAnyCapability(user, PLUGIN_READ_CAPABILITIES)
}

export function canRunPluginBackgroundWork(user: CmsCurrentUser | null): boolean {
  // Layout tests can render outside AdminSessionProvider; keep that preview
  // mode unrestricted. Real authenticated layouts always receive a user.
  if (!user) return true
  return canAccessPluginsWorkspace(user)
}

export function canAccessWorkspace(user: CmsCurrentUser | null, workspace: AdminWorkspace): boolean {
  switch (workspace) {
    case 'dashboard':
      return hasCapability(user, 'dashboard.read')
    case 'site':
      // site.read covers the read-only canvas viewer. Editors of any flavour
      // (structure / content / style) also have site.read on a well-formed
      // role, so this single check is sufficient.
      return hasCapability(user, 'site.read')
    case 'pluginPage':
      return canAccessPluginsWorkspace(user)
    case 'account':
      // Self-targeted page — every authenticated user can manage their own
      // profile + devices. Anonymous visitors fall through to false.
      return user !== null
  }
}

export function firstAccessibleWorkspace(user: CmsCurrentUser | null): AdminWorkspace | null {
  // Dashboard comes first — it's the canonical admin home. Falls through to
  // the next accessible workspace for users whose role doesn't grant
  // `dashboard.read` (rare; only happens with hand-edited custom roles).
  // 'account' is last: every authenticated user can reach it (no capability
  // gate), so it's the universal fallback for a role that only holds
  // Settings-panel capabilities (Plugins/Users/AI) with no routable workspace.
  const order: AdminWorkspace[] = ['dashboard', 'site', 'account']
  return order.find((workspace) => canAccessWorkspace(user, workspace)) ?? null
}

export function workspacePath(workspace: AdminWorkspace): string {
  switch (workspace) {
    case 'dashboard':
      return '/admin/dashboard'
    case 'site':
      return '/admin/site'
    case 'pluginPage':
      return '/admin/plugins'
    case 'account':
      return '/admin/account'
  }
}

// Reference unused imports so the linter doesn't strip them when not consumed
// downstream yet (RUNTIME_STORAGE_CAPABILITIES is here for symmetry — the
// runtime workspace doesn't currently have its own canAccess gate because
// there is no dedicated runtime workspace; storage admin lives under media).
void RUNTIME_STORAGE_CAPABILITIES
