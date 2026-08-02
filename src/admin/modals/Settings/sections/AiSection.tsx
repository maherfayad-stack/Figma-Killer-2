/**
 * AiSection — the AI panel inside the Settings modal.
 *
 * Formerly the standalone `/admin/ai` page; folded into Settings so
 * managing AI provider credentials, defaults, MCP connectors, and the usage
 * audit doesn't leave the surface the operator was already on. Capability-
 * gated exactly as the old page: `ai.providers.manage` unlocks Providers /
 * Defaults / MCP, `ai.audit.read` unlocks Audit. A null `currentUser` means
 * unrestricted (dev/owner session, layout tests).
 *
 * The four tab components moved from `pages/ai/tabs/` to `./ai/` essentially
 * untouched — each already owns its data loading and mutation state; only
 * their relative imports (`ai/api`, the shared dialog styles module, and the
 * page-level CSS module) were repointed at their new depth.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { ProvidersTab } from './ai/ProvidersTab'
import { DefaultsTab } from './ai/DefaultsTab'
import { McpTab } from './ai/McpTab'
import { AuditTab } from './ai/AuditTab'
import styles from './ai/ai.module.css'
import s from '../SettingsModal.module.css'

type Tab = 'providers' | 'defaults' | 'mcp' | 'audit'

const TAB_LABELS: Record<Tab, string> = {
  providers: 'Providers',
  defaults: 'Defaults',
  mcp: 'MCP',
  audit: 'Audit',
}

export function AiSection() {
  const currentUser = useCurrentAdminUser()
  const unrestricted = !currentUser
  const canManage = unrestricted || hasCapability(currentUser, 'ai.providers.manage')
  const canReadAudit = unrestricted || hasCapability(currentUser, 'ai.audit.read')

  const availableTabs: Tab[] = []
  if (canManage) availableTabs.push('providers', 'defaults', 'mcp')
  if (canReadAudit) availableTabs.push('audit')

  const [tab, setTab] = useState<Tab>('providers')
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0] ?? 'providers'

  return (
    <div className={styles.body}>
      <p className={s.sectionDescription}>
        Configure AI provider credentials, per-scope defaults, MCP connectors, and review usage.
      </p>

      <div role="tablist" aria-label="AI sections" className={styles.tabsRow}>
        {availableTabs.map((item) => (
          <Button
            key={item}
            type="button"
            variant={activeTab === item ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTab(item)}
            role="tab"
            aria-selected={activeTab === item}
            data-testid={`ai-tab-${item}`}
          >
            <span>{TAB_LABELS[item]}</span>
          </Button>
        ))}
      </div>

      {activeTab === 'providers' && <ProvidersTab />}
      {activeTab === 'defaults' && <DefaultsTab />}
      {activeTab === 'mcp' && <McpTab />}
      {activeTab === 'audit' && <AuditTab />}
    </div>
  )
}
