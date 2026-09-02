import { describe, expect, it } from 'bun:test'
import type { CoreCapability } from '@core/capabilities'
import type { CmsCurrentUser } from '@core/persistence'
import {
  canAccessAiWorkspace,
  canAccessPluginsWorkspace,
  canAccessUsersWorkspace,
  canAccessWorkspace,
  canDeleteMedia,
  canEditContent,
  canEditStructure,
  canEditStyle,
  canManageTable,
  canReadTable,
  canReplaceMedia,
  canSaveDraftSite,
  canWriteMedia,
  firstAccessibleWorkspace,
  hasCapability,
  workspacePath,
} from '../../admin/access'

function user(id: string, capabilities: CoreCapability[]): CmsCurrentUser {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    status: 'active',
    role: {
      id: `role-${id}`,
      slug: `role-${id}`,
      name: `Role ${id}`,
      description: '',
      isSystem: false,
      capabilities,
    },
    capabilities,
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordUpdatedAt: null,
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaRecoveryCodesRemaining: 0,
    stepUpAuthMode: 'required',
    stepUpWindowMinutes: 15,
    avatarMediaId: null,
    avatarUrl: null,
    gravatarHash: 'hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('admin capability access helpers', () => {
  it('maps capability families to the expected admin workspaces', () => {
    const operator = user('operator', [
      'dashboard.read',
      'site.read',
      'site.content.edit',
    ])
    expect(canAccessWorkspace(operator, 'dashboard')).toBe(true)
    expect(canAccessWorkspace(operator, 'site')).toBe(true)
    expect(canAccessPluginsWorkspace(operator)).toBe(false)
    expect(canAccessUsersWorkspace(operator)).toBe(false)
    expect(canAccessAiWorkspace(operator)).toBe(false)
    expect(canAccessWorkspace(operator, 'account')).toBe(true)
    expect(firstAccessibleWorkspace(operator)).toBe('dashboard')

    // Plugins/Users/AI are Settings-modal panels, not routable workspaces —
    // a role that only holds their capabilities falls through to the
    // universal 'account' fallback (every authenticated user can reach it).
    const userManager = user('user-manager', ['users.manage'])
    expect(canAccessUsersWorkspace(userManager)).toBe(true)
    expect(firstAccessibleWorkspace(userManager)).toBe('account')

    const pluginOperator = user('plugin-operator', ['plugins.lifecycle'])
    expect(canAccessPluginsWorkspace(pluginOperator)).toBe(true)
    expect(canAccessWorkspace(pluginOperator, 'pluginPage')).toBe(true)
    expect(firstAccessibleWorkspace(pluginOperator)).toBe('account')

    const aiAuditor = user('ai-auditor', ['ai.audit.read'])
    expect(canAccessAiWorkspace(aiAuditor)).toBe(true)
    expect(firstAccessibleWorkspace(aiAuditor)).toBe('account')

    expect(canAccessWorkspace(null, 'account')).toBe(false)
    expect(firstAccessibleWorkspace(null)).toBeNull()
    expect(workspacePath('pluginPage')).toBe('/admin/plugins')
  })

  it('keeps editor write modes independent in the UI policy layer', () => {
    const contentEditor = user('content-editor', ['site.read', 'site.content.edit'])
    expect(canEditContent(contentEditor)).toBe(true)
    expect(canEditStyle(contentEditor)).toBe(false)
    expect(canEditStructure(contentEditor)).toBe(false)
    expect(canSaveDraftSite(contentEditor)).toBe(true)

    const styleEditor = user('style-editor', ['site.read', 'site.style.edit'])
    expect(canEditContent(styleEditor)).toBe(false)
    expect(canEditStyle(styleEditor)).toBe(true)
    expect(canEditStructure(styleEditor)).toBe(false)
    expect(canSaveDraftSite(styleEditor)).toBe(true)

    const structureWithoutPages = user('structure-without-pages', ['site.read', 'site.structure.edit'])
    expect(canEditStructure(structureWithoutPages)).toBe(false)
    expect(canSaveDraftSite(structureWithoutPages)).toBe(true)

    const structureEditor = user('structure-editor', [
      'site.read',
      'site.structure.edit',
      'pages.edit',
    ])
    expect(canEditStructure(structureEditor)).toBe(true)
    expect(canEditContent(structureEditor)).toBe(false)
    expect(canEditStyle(structureEditor)).toBe(false)

    expect(canEditStructure(null)).toBe(true)
    expect(canEditContent(null)).toBe(true)
    expect(canEditStyle(null)).toBe(true)
    expect(canSaveDraftSite(null)).toBe(true)
  })

  it('gates data-table and media capabilities by family, independent of each other', () => {
    const dataManager = user('data-manager', ['data.custom.tables.manage'])
    // System tables are a separate family: custom-manage does not grant system
    // visibility, and a system-read persona never sees custom tables.
    expect(canReadTable(dataManager, { system: false })).toBe(true)
    expect(canReadTable(dataManager, { system: true })).toBe(false)
    expect(canManageTable(dataManager, { system: false })).toBe(true)
    expect(canManageTable(dataManager, { system: true })).toBe(false)

    const systemViewer = user('system-viewer', ['data.system.tables.read'])
    expect(canReadTable(systemViewer, { system: true })).toBe(true)
    expect(canReadTable(systemViewer, { system: false })).toBe(false)
    expect(canManageTable(systemViewer, { system: true })).toBe(false)

    const mediaOperator = user('media-operator', [
      'media.read',
      'media.write',
      'media.replace',
      'media.delete',
    ])
    expect(hasCapability(mediaOperator, 'media.read')).toBe(true)
    expect(canWriteMedia(mediaOperator)).toBe(true)
    expect(canReplaceMedia(mediaOperator)).toBe(true)
    expect(canDeleteMedia(mediaOperator)).toBe(true)
    expect(canReadTable(mediaOperator, { system: false })).toBe(false)
  })
})
