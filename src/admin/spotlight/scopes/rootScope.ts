/**
 * Root scope — the default scope shown when the spotlight opens.
 *
 * Aggregates all built-in commands from the command registry.
 *
 * Phase 3: providers fire in parallel when typing in the root palette, so
 * ⌘K → typing "home" returns the Home page row AND any Home matches across
 * plugin pages. Each provider is capped at 25 results; results are grouped
 * by provider label.
 */

import type { Scope } from '../types'
import { getAllCommands } from '../builtinCommands'
import { pagesProvider } from '../providers/pagesProvider'
import { pluginPagesProvider } from '../providers/pluginPagesProvider'

export const rootScope: Scope = {
  id: 'root',
  placeholder: 'Type a command or search…',
  commands: () => getAllCommands(),
  providers: [
    pagesProvider,
    pluginPagesProvider,
  ],
}
