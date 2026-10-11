/**
 * The palette's default (empty-query) list: Enter runs the pre-highlighted
 * first row, so it must never be a destructive command.
 */

import { describe, it, expect } from 'bun:test'
import { rankCommands } from '../matcher'
import type { Command, CommandContext, CommandGroup } from '../types'

const ctx = { workspace: 'site' } as unknown as CommandContext

function mk(id: string, group: CommandGroup, extra: Partial<Command> = {}): Command {
  return { id, title: id, group, workspaces: ['site'], run: () => {}, ...extra }
}

describe('rankCommands (empty query)', () => {
  it('ranks a destructive command last even when its when() holds', () => {
    const commands = [
      mk('pages.deletePage', 'pages', { destructive: true, when: () => true }),
      mk('navigation.goToSite', 'navigation'),
      mk('editor.save', 'editor'),
    ]
    const ranked = rankCommands(commands, '', ctx, [])
    expect(ranked[ranked.length - 1]?.command.id).toBe('pages.deletePage')
    expect(ranked[0]?.command.destructive).toBeUndefined()
  })
})
