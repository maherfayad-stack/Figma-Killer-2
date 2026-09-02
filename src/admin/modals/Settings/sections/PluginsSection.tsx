/**
 * PluginsSection — the Plugins panel inside the Settings modal.
 *
 * Formerly a standalone `/admin/plugins` page; folded into Settings so
 * managing plugins doesn't leave the surface the operator was already on.
 * Plugin-contributed admin pages (`/admin/plugins/:pluginId/:pageId`) are
 * unaffected — only this list/management view moved.
 */
import { Button } from '@ui/components/Button'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { PluginCard } from '@admin/pages/plugins/components/PluginCard/PluginCard'
import { PluginRemoveDialog } from '@admin/pages/plugins/components/PluginRemoveDialog/PluginRemoveDialog'
import { PermissionReviewSection } from '@admin/pages/plugins/components/PermissionReviewSection'
import { PluginSettingsDialog } from '@admin/pages/plugins/components/PluginSettingsDialog/PluginSettingsDialog'
import { PluginSchedulesDialog } from '@admin/pages/plugins/components/PluginSchedulesDialog/PluginSchedulesDialog'
import { isSandboxRelatedError, usePluginsWorkspace } from '@admin/pages/plugins/hooks/usePluginsWorkspace'
import { notifyCmsPluginsChanged } from '@admin/pages/plugins/utils/pluginEvents'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import {
  canConfigurePlugins,
  canInstallPlugins,
  canManagePluginLifecycle,
} from '@admin/access'
import styles from '@admin/pages/plugins/plugins.module.css'
import s from '../SettingsModal.module.css'

// Number of skeleton plugin cards rendered while the installed-plugin
// list is loading. Three matches a typical fresh-install showing
// (e.g. host plugins + Analytics). PluginCard's `loading` prop owns
// the actual skeleton markup — this component only decides count.
const SKELETON_CARD_COUNT = 3

export function PluginsSection() {
  const currentUser = useAuthenticatedAdminUser()
  const canConfigure = canConfigurePlugins(currentUser)
  const canInstall = canInstallPlugins(currentUser)
  const canManageLifecycle = canManagePluginLifecycle(currentUser)
  const vm = usePluginsWorkspace()
  const {
    fileInputRef,
    payload,
    loading,
    uploading,
    busyPluginId,
    error,
    editorActivationErrors,
    pendingInstall,
    settingsPluginId,
    schedulesPluginId,
    pendingRemove,
    removeFailure,
  } = vm

  return (
    <div className={styles.pluginsBody} data-testid="plugins-admin-canvas">
      <p className={s.sectionDescription}>
        Install admin extensions and control what they add to the CMS.
      </p>

      {canInstall && (
        <div className={s.sectionActions}>
          <Button
            variant="primary"
            size="md"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon size={15} aria-hidden="true" />
            <span>{uploading ? 'Uploading' : 'Upload Plugin'}</span>
          </Button>
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            aria-label="Plugin file"
            type="file"
            accept="application/json,.json,.plugin.json,.pbplugin,.zip,application/zip"
            onChange={(event) => void vm.handleUpload(event)}
          />
        </div>
      )}

      {error && (
        <div role="alert">
          <p className={styles.error}>{error}</p>
          {isSandboxRelatedError(error) && (
            <p className={styles.errorHint}>
              This looks like a plugin sandbox issue. See the{' '}
              <a
                href="https://github.com/MaherFayad/Figma-Killer-2/blob/main/docs/features/plugin-system.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                sandbox documentation
              </a>
              {' '}for what's allowed inside plugin code.
            </p>
          )}
        </div>
      )}

      {removeFailure && (
        <div role="alert" className={styles.removeFailure}>
          <p className={styles.error}>{removeFailure.message}</p>
          <p className={styles.errorHint}>
            Removing anyway skips the plugin&rsquo;s cleanup code — external
            resources it created (webhooks, third-party registrations) may
            remain.
          </p>
          <div className={styles.removeFailureActions}>
            <Button
              variant="destructive"
              size="sm"
              disabled={busyPluginId === removeFailure.plugin.id}
              onClick={() =>
                vm.setPendingRemove({ plugin: removeFailure.plugin, force: true })
              }
            >
              Remove anyway
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => vm.setRemoveFailure(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {pendingInstall && canInstall && (
        <PermissionReviewSection
          pending={pendingInstall}
          uploading={uploading}
          onCancel={() => vm.setPendingInstall(null)}
          onConfirm={() => void vm.installPendingPlugin(pendingInstall)}
        />
      )}

      <div
        className={styles.pluginsList}
        aria-label="Installed plugins"
        aria-busy={loading || undefined}
      >
        {loading ? (
          // Render N skeleton cards while the plugins payload is in
          // flight. PluginCard renders its own universal skeleton
          // body when `loading` is set — no per-page skeleton markup,
          // no mock data.
          Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
            <PluginCard key={i} loading />
          ))
        ) : payload.plugins.length === 0 ? (
          <p className={styles.emptyState}>No plugins installed yet.</p>
        ) : (
          payload.plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              busy={busyPluginId === plugin.id}
              editorActivationError={editorActivationErrors[plugin.id]}
              canConfigure={canConfigure}
              canInstall={canInstall}
              canManageLifecycle={canManageLifecycle}
              onOpenSettings={(p) => vm.setSettingsPluginId(p.id)}
              onOpenSchedules={(p) => vm.setSchedulesPluginId(p.id)}
              onInstallPack={(p) => void vm.installPluginPack(p)}
              onRestart={(p) => void vm.restartPlugin(p)}
              onReinstall={() => fileInputRef.current?.click()}
              onToggle={(p) => void vm.togglePlugin(p)}
              onRemove={(p) => vm.setPendingRemove({ plugin: p, force: false })}
            />
          ))
        )}
      </div>

      {settingsPluginId && (
        <PluginSettingsDialog
          pluginId={settingsPluginId}
          pluginName={
            payload.plugins.find((p) => p.id === settingsPluginId)?.name ??
            settingsPluginId
          }
          onClose={() => vm.setSettingsPluginId(null)}
          onSaved={() => {
            notifyCmsPluginsChanged()
            void vm.loadPlugins()
          }}
        />
      )}

      {schedulesPluginId && (
        <PluginSchedulesDialog
          pluginId={schedulesPluginId}
          pluginName={
            payload.plugins.find((p) => p.id === schedulesPluginId)?.name ??
            schedulesPluginId
          }
          canManageLifecycle={canManageLifecycle}
          onClose={() => vm.setSchedulesPluginId(null)}
        />
      )}

      {pendingRemove && (
        <PluginRemoveDialog
          plugin={pendingRemove.plugin}
          force={pendingRemove.force}
          busy={busyPluginId === pendingRemove.plugin.id}
          onClose={() => vm.setPendingRemove(null)}
          onConfirm={async () => {
            const target = pendingRemove
            vm.setPendingRemove(null)
            await vm.executeRemovePlugin(target.plugin, target.force)
          }}
        />
      )}
    </div>
  )
}
