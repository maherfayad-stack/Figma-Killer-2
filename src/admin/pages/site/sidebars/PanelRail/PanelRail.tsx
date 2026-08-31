import { useSyncExternalStore, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import type { LeftSidebarPanelId } from '@site/store/slices/uiSlice'
import type { IconComponent } from 'pixel-art-icons/types'
import { CommentBubbleIcon } from '@ui/components/InspectorIcons'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { Button } from '@ui/components/Button'
import { assignRailAccents, railTintVar, type RailAccent } from '@ui/railAccent'
import { pluginRuntime } from '@core/plugins/runtime'
import { resolvePluginPanelIcon } from './pluginPanelIcons'
import styles from './PanelRail.module.css'

interface PrimaryRailItem {
  id: LeftSidebarPanelId
  label: string
  icon: IconComponent
  iconName: string
}

interface RailItem {
  id: string
  label: string
  icon: IconComponent
  iconName: string
  accent: RailAccent
  open: boolean
  disabled?: boolean
  onToggle: () => void
  disabledTitle?: string
  /** Plugin-supplied shortcut hint shown in the button tooltip. */
  shortcutLabel?: string
}

const PRIMARY_RAIL_ITEMS: PrimaryRailItem[] = [
  {
    id: 'explorer',
    label: 'Explorer',
    icon: DatabaseSolidIcon,
    iconName: 'database-solid',
  },
  {
    id: 'framework',
    label: 'Framework',
    icon: ColorsSwatchSolidIcon,
    iconName: 'colors-swatch',
  },
  {
    id: 'selectors',
    label: 'Classes',
    icon: PaintBucketSolidIcon,
    iconName: 'paint-bucket',
  },
  {
    id: 'inspect',
    label: 'Inspect',
    icon: EyeSolidIcon,
    iconName: 'eye-solid',
  },
  {
    id: 'content',
    label: 'Content',
    icon: GlobeSolidIcon,
    iconName: 'globe-solid',
  },
]

const GLOBAL_RAIL_ITEMS: PrimaryRailItem[] = [
  {
    id: 'agent',
    label: 'AI assistant',
    icon: AiSettingsSolidIcon,
    iconName: 'ai-settings-solid',
  },
]

interface PanelRailProps {
  editable?: boolean
  canUseAiChat?: boolean
  railOnly?: boolean
}

const subscribePluginRuntime = (cb: () => void) => pluginRuntime.subscribe(cb)
const getPluginPanelsSnapshot = () => pluginRuntime.getPanels()
// Reuse the same empty array on the server so useSyncExternalStore doesn't
// detect a snapshot mismatch.
const SERVER_PLUGIN_PANELS_SNAPSHOT: ReturnType<typeof getPluginPanelsSnapshot> = []

export function PanelRail({
  editable = true,
  canUseAiChat = true,
  railOnly = false,
}: PanelRailProps) {
  const explorerOpen = useEditorStore((s) => s.explorerPanelOpen)
  const selectorsOpen = useEditorStore((s) => s.selectorsPanelOpen)
  const frameworkOpen = useEditorStore((s) => s.frameworkPanelOpen)
  const dependenciesOpen = useEditorStore((s) => s.dependenciesPanelOpen)
  const inspectOpen = useEditorStore((s) => s.inspectPanelOpen)
  const contentOpen = useEditorStore((s) => s.contentPanelOpen)
  const agentOpen = useEditorStore((s) => s.isAgentOpen)
  const commentsPaneOpen = useEditorStore((s) => s.commentsPaneOpen)
  const setCommentsPaneOpen = useEditorStore((s) => s.setCommentsPaneOpen)
  const activePluginPanelId = useEditorStore((s) => s.activePluginPanelId)

  const toggleLeftSidebarPanel = useEditorStore((s) => s.toggleLeftSidebarPanel)
  const setLeftSidebarPanel = useEditorStore((s) => s.setLeftSidebarPanel)
  const toggleActivePluginPanel = useEditorStore((s) => s.toggleActivePluginPanel)
  const setActivePluginPanel = useEditorStore((s) => s.setActivePluginPanel)
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)

  // Subscribe to the plugin runtime so newly-registered panels appear in the
  // rail without a manual refresh. The runtime emits on every register/reset
  // — same channel toolbar buttons and commands already use.
  const pluginPanels = useSyncExternalStore(
    subscribePluginRuntime,
    getPluginPanelsSnapshot,
    () => SERVER_PLUGIN_PANELS_SNAPSHOT,
  )

  const panelOpenById = {
    explorer: explorerOpen,
    agent: agentOpen,
    selectors: selectorsOpen,
    framework: frameworkOpen,
    dependencies: dependenciesOpen,
    inspect: inspectOpen,
    content: contentOpen,
  } satisfies Record<LeftSidebarPanelId, boolean>

  // Read-only callers (Viewer / Client) see only the Explorer panel (the
  // Layers / Pages / Media navigation surfaces). Style/runtime editing panels
  // only appear when the user can edit structure. The AI assistant follows
  // `ai.chat`, independent of editability.
  const READ_ONLY_RAIL_IDS = new Set<LeftSidebarPanelId>(['explorer', 'inspect'])
  const visiblePrimaryItems = editable
    ? PRIMARY_RAIL_ITEMS
    : PRIMARY_RAIL_ITEMS.filter((item) => READ_ONLY_RAIL_IDS.has(item.id))
  const visibleGlobalItems = canUseAiChat ? GLOBAL_RAIL_ITEMS : []

  // D3 — `workspace` was a dead prop (`'site' | 'content' | 'media'`; only
  // `'site'` was ever passed, and the `'content'`/`'media'` workspaces don't
  // exist on disk). Deleted the prop, but the identity STRING keeps its
  // literal `'site:'` prefix rather than dropping it outright —
  // `assignRailAccents` hashes this exact string per item, and several rail
  // colors (see the `primaryAccents` comment below) are already deliberately
  // pinned to today's hash output; changing the string would silently
  // reshuffle colors for users with no functional prop left to explain why.
  function railIdentity(item: PrimaryRailItem) {
    return `site:${item.id}:${item.label}`
  }

  function revealBuiltInPanel(panelId: LeftSidebarPanelId) {
    setPropertiesPanel({ collapsed: true })
    setLeftSidebarPanel(panelId)
  }

  function revealPluginPanel(panelId: string) {
    setPropertiesPanel({ collapsed: true })
    setActivePluginPanel(panelId)
  }

  function toRailItem(item: PrimaryRailItem, accent: RailAccent): RailItem {
    return {
      ...item,
      open: panelOpenById[item.id] && !railOnly,
      onToggle: () => {
        if (railOnly) {
          revealBuiltInPanel(item.id)
          return
        }
        toggleLeftSidebarPanel(item.id)
      },
      accent,
    }
  }

  // Explorer keeps the 'gold' accent the standalone Layers rail button used
  // to resolve to (identity hash of 'site:layers:Layers', first item, no
  // collision shift) — consolidating Layers/Site/Media into one rail button
  // shouldn't change its established color.
  const primaryAccents = assignRailAccents(
    visiblePrimaryItems,
    railIdentity,
    (item) => (item.id === 'explorer' ? 'gold' : null),
  )
  const globalAccents = assignRailAccents(
    visibleGlobalItems,
    (item) => `global:${item.id}:${item.label}`,
  )
  const primaryItems: RailItem[] = visiblePrimaryItems.map((item, index) => (
    toRailItem(item, primaryAccents[index] ?? 'mint')
  ))
  const globalItems: RailItem[] = visibleGlobalItems.map((item, index) => (
    toRailItem(item, globalAccents[index] ?? 'mint')
  ))

  /**
   * Comments sits in the global group with the AI assistant rather than in the
   * primary one, because like the assistant it is NOT a left-sidebar panel:
   * its surface is the RIGHT sidebar, beside Properties, where you inspect the
   * thing you just clicked. That is also why it cannot ride
   * `toggleLeftSidebarPanel` and carries its own toggle.
   *
   * It exists because the canvas entry points (`C`, the Comment tool button,
   * clicking a pin) are not discoverable from the chrome — the first thing
   * reported after the pane moved was that comments looked "removed". Outside
   * the `editable` gate on purpose: the Client role (`site.content.edit` only)
   * is the reviewer this feature exists for, and commenting is not a
   * structural edit.
   */
  const commentsItem: RailItem = {
    id: 'comments',
    label: 'Comments',
    // Hand-drawn (`@ui/components/InspectorIcons`): the vendored
    // pixel-art-icons subset has no speech bubble and adding one needs the
    // private upstream checkout. Gate 3 of `icon-catalog-integrity` exempts
    // `src/ui/` for exactly this.
    icon: CommentBubbleIcon,
    iconName: 'comment-bubble',
    accent: 'lilac',
    open: commentsPaneOpen,
    onToggle: () => setCommentsPaneOpen(!commentsPaneOpen),
  }
  const globalStackItems: RailItem[] = [commentsItem, ...globalItems]

  // Plugin panels show up after the primary group when editing. Panels with an
  // explicit accent keep it; the rest get deterministic identity colors with
  // repeat avoidance within the plugin rail group.
  const pluginAccents = assignRailAccents(
    pluginPanels,
    (panel) => `plugin:${panel.id}:${panel.label}`,
    (panel) => panel.accent,
  )
  const pluginItems: RailItem[] = editable
    ? pluginPanels.map((panel, index) => ({
        id: `plugin:${panel.id}`,
        label: panel.label,
        icon: resolvePluginPanelIcon(panel.iconName),
        iconName: panel.iconName,
        accent: pluginAccents[index] ?? 'mint',
        open: activePluginPanelId === panel.id && !railOnly,
        onToggle: () => {
          if (railOnly) {
            revealPluginPanel(panel.id)
            return
          }
          toggleActivePluginPanel(panel.id)
        },
        shortcutLabel: panel.shortcutLabel,
      }))
    : []

  return (
    <nav
      aria-label="Panel dock"
      className={styles.rail}
      data-testid="panel-rail"
    >
      <div className={styles.primaryStack}>
        <div className={styles.itemGroup} data-testid="panel-rail-primary">
          {primaryItems.map((item) => (
            <RailButton key={item.id} item={item} />
          ))}
        </div>
        {pluginItems.length > 0 && (
          <div className={styles.itemGroup} data-testid="panel-rail-plugins">
            {pluginItems.map((item) => (
              <RailButton key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
      {globalStackItems.length > 0 && (
        <div className={styles.globalGroup} data-testid="panel-rail-global">
          {globalStackItems.map((item) => (
            <RailButton key={item.id} item={item} />
          ))}
        </div>
      )}
    </nav>
  )
}

function RailButton({ item }: { item: RailItem }) {
  const RailIcon = item.icon
  const action = item.open ? 'Close' : 'Open'
  const style = {
    '--rail-icon-tint': railTintVar(item.accent),
  } as CSSProperties
  const title = item.disabled
    ? item.disabledTitle
    : item.shortcutLabel
      ? `${item.label} panel (${item.shortcutLabel})`
      : `${item.label} panel`

  return (
    <Button
      variant="ghost"
      size="md"
      iconOnly
      pressed={item.open}
      aria-label={`${action} ${item.label} panel`}
      disabled={item.disabled}
      tooltip={title}
      data-testid={`panel-rail-${item.id}`}
      data-icon={item.iconName}
      data-accent={item.accent}
      style={style}
      onClick={item.onToggle}
      className={styles.railButton}
    >
      <span className={styles.activeIndicator} aria-hidden="true" />
      <RailIcon size={16} className={styles.railIcon} />
    </Button>
  )
}
