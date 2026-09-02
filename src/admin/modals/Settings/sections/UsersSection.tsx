/**
 * UsersSection — the Users panel inside the Settings modal.
 *
 * Formerly a standalone `/admin/users` page; folded into Settings so
 * managing users/roles/audit doesn't leave the surface the operator was
 * already on. Capability-gated: figures out which sub-tabs the current
 * admin is allowed to see (`users.manage`, `roles.manage`, `audit.read`),
 * loads the underlying data once via `useUsersPageData`, and delegates
 * rendering to the per-tab components in `@admin/pages/users/tabs/`.
 */
import { useEffect, useEffectEvent, useState } from 'react'
import { peekPendingAction } from '@admin/spotlight/pendingAction'
import { Button } from '@ui/components/Button'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { AuditTab } from '@admin/pages/users/tabs/AuditTab'
import { RolesTab } from '@admin/pages/users/tabs/RolesTab'
import { UsersTab } from '@admin/pages/users/tabs/UsersTab'
import { useUsersPageData } from '@admin/pages/users/hooks/useUsersPageData'
import { tabLabel } from '@admin/pages/users/utils/format'
import type { Tab, UsersPageLoadAccess } from '@admin/pages/users/types'
import styles from '@admin/pages/users/users.module.css'
import s from '../SettingsModal.module.css'

export function UsersSection() {
  const currentUser = useCurrentAdminUser()
  const unrestricted = !currentUser
  const canManageUsers = unrestricted || hasCapability(currentUser, 'users.manage')
  const canManageRoles = unrestricted || hasCapability(currentUser, 'roles.manage')
  const canReadAudit = unrestricted || hasCapability(currentUser, 'audit.read')
  const canReadRoleOptions = canManageUsers || canManageRoles

  const loadAccess: UsersPageLoadAccess = { canManageUsers, canReadRoleOptions, canReadAudit }
  const data = useUsersPageData(loadAccess)

  const availableTabs: Tab[] = []
  if (canManageUsers) availableTabs.push('users')
  if (canManageRoles) availableTabs.push('roles')
  if (canReadAudit) availableTabs.push('audit')

  const [tab, setTab] = useState<Tab>('users')
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0] ?? 'users'

  // Cross-workspace spotlight actions can target this panel. Peek (don't
  // consume) at the pending action so the appropriate tab is selected before
  // the tab itself mounts and consumes the action. Microtask defer to keep
  // the setState off the commit phase without risking the macrotask race
  // that setTimeout(0) would expose to fast cross-page navigations.
  //
  // useEffectEvent reads the latest availableTabs at mount-fire time without
  // making the effect dependent on it (rebinding tabs while the panel is
  // already mounted shouldn't re-trigger the pending-action routing).
  const consumePendingTabSelection = useEffectEvent(() => {
    const newRolePending =
      peekPendingAction('users.newRole') && availableTabs.includes('roles')
    const invitePending =
      peekPendingAction('users.invite') && availableTabs.includes('users')
    if (!newRolePending && !invitePending) return
    queueMicrotask(() => {
      if (newRolePending) setTab('roles')
      else if (invitePending) setTab('users')
    })
  })
  useEffect(() => {
    consumePendingTabSelection()
  }, [])

  return (
    <div className={styles.body}>
      <p className={s.sectionDescription}>
        Manage admin access, custom roles, and security audit events.
      </p>

      <div role="tablist" aria-label="Users sections" className={styles.tabsRow}>
        {availableTabs.map((item) => (
          <Button
            key={item}
            type="button"
            variant={activeTab === item ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTab(item)}
          >
            <span>{tabLabel(item)}</span>
          </Button>
        ))}
      </div>

      {data.error && <p className={styles.error} role="alert">{data.error}</p>}

      {activeTab === 'users' && <UsersTab data={data} canManageUsers={canManageUsers} />}
      {activeTab === 'roles' && <RolesTab data={data} canManageRoles={canManageRoles} />}
      {activeTab === 'audit' && <AuditTab data={data} />}
    </div>
  )
}
