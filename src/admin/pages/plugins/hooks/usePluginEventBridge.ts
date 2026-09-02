/**
 * Plugin event bridge — global side-effect handler for the live plugin
 * SSE stream. Mount once at the admin shell so plugin lifecycle events
 * (crash / parked) reach the user from any admin route via a toast,
 * regardless of which admin page they're currently on. `parked`
 * (auto-respawn budget exhausted) gets the highest-severity styling
 * because it requires manual action.
 */

import { useEffect } from 'react'
import { pushToast } from '@ui/components/Toast'
import { subscribePluginEvents, type PluginEvent } from '../utils/pluginEventStream'

export function usePluginEventBridge(enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    return subscribePluginEvents(handlePluginEvent)
  }, [enabled])
}

function handlePluginEvent(event: PluginEvent): void {
  switch (event.kind) {
    case 'crash':
      // Within budget — auto-respawn already underway. Keep the user
      // informed but don't escalate to error styling.
      pushToast({
        kind: 'warning',
        title: `Plugin "${event.pluginId}" crashed`,
        body: `Auto-respawning (crash #${event.recentCrashCount} in 5min). Reason: ${event.reason}`,
        location: 'plugin-event-bridge',
      })
      break

    case 'parked':
      // Crash budget exceeded — needs manual intervention.
      pushToast({
        kind: 'error',
        title: `Plugin "${event.pluginId}" parked in error state`,
        body: `Crashed ${event.recentCrashCount} times in 5min. Open Settings → Plugins to restart.`,
        location: 'plugin-event-bridge',
      })
      break

    case 'recovered':
    case 'restarted':
    case 'disabled':
    case 'uninstalled':
    case 'installed':
    case 'updated':
    case 'enabled':
      // No cross-page side effect needed — the Plugins panel re-fetches
      // its own list on next open.
      break
  }
}
