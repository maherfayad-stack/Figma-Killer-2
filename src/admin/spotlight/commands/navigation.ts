/**
 * Navigation commands — §4.1 of the Command Spotlight master plan.
 *
 * Commands that navigate between admin workspaces.
 * Each command declares the capability(ies) required to reach the target
 * workspace; the palette's `filterCommands` hides any whose user lacks them.
 * The lists mirror the predicates in `canAccessWorkspace` (access.ts) — keep
 * them in sync if a workspace's gate changes.
 */

import type { Command } from '../types'
import { useAdminUi } from '@admin/state/adminUi'

/** Mirrors `canAccessUsersWorkspace` in access.ts. */
const USERS_ACCESS_CAPABILITIES = [
  'users.manage',
  'roles.manage',
  'audit.read',
] as const

/** Mirrors `canAccessPluginsWorkspace` in access.ts. */
const PLUGINS_ACCESS_CAPABILITIES = [
  'plugins.read',
  'plugins.configure',
  'plugins.install',
  'plugins.lifecycle',
] as const

export function getNavigationCommands(): Command[] {
  return [
    {
      id: 'navigation.goToSite',
      title: 'Go to Site editor',
      subtitle: 'Open the visual editor',
      group: 'navigation',
      iconName: 'layout-solid',
      keywords: ['site', 'editor', 'pages', 'builder', 'visual'],
      workspaces: ['any'],
      capability: 'site.read',
      run: (ctx) => {
        ctx.navigate('/admin/site')
        ctx.closeSpotlight()
      },
    },
    {
      id: 'navigation.goToPlugins',
      title: 'Open Settings → Plugins',
      subtitle: 'Manage installed plugins',
      group: 'navigation',
      iconName: 'package-solid',
      keywords: ['plugins', 'extensions', 'addons', 'install', 'settings'],
      workspaces: ['any'],
      capability: PLUGINS_ACCESS_CAPABILITIES,
      run: (ctx) => {
        ctx.closeSpotlight()
        useAdminUi.getState().openSettings('plugins')
      },
    },
    {
      id: 'navigation.goToUsers',
      title: 'Open Settings → Users',
      subtitle: 'Manage users and roles',
      group: 'navigation',
      iconName: 'cursor-minimal-solid',
      keywords: ['users', 'roles', 'team', 'members', 'permissions', 'audit', 'settings'],
      workspaces: ['any'],
      capability: USERS_ACCESS_CAPABILITIES,
      run: (ctx) => {
        ctx.closeSpotlight()
        useAdminUi.getState().openSettings('users')
      },
    },
    {
      // Account is reachable by every authenticated user. No capability gate —
      // the surrounding admin route is itself behind a session, so simply not
      // declaring `capability` here matches `canAccessWorkspace('account')`'s
      // `user !== null` check.
      id: 'navigation.goToAccount',
      title: 'Go to Account',
      subtitle: 'Manage your profile and security',
      group: 'navigation',
      iconName: 'settings-cog-solid',
      keywords: ['account', 'profile', 'security', 'password', 'mfa', 'sessions'],
      workspaces: ['any'],
      run: (ctx) => {
        ctx.navigate('/admin/account')
        ctx.closeSpotlight()
      },
    },
  ]
}
