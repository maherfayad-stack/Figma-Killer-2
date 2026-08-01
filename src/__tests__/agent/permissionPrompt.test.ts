import { describe, it, expect, afterEach } from 'bun:test'
import {
  __parkedPermissionPromptCount,
  abandonPermissionPrompts,
  awaitPermissionDecision,
  describePermissionRequest,
  parsePermissionRequestInput,
  settlePermissionDecision,
} from '@site/agent/permissionPrompt'

afterEach(() => {
  abandonPermissionPrompts()
})

describe('describePermissionRequest', () => {
  it('names the file for a read outside the project', () => {
    const request = describePermissionRequest('Read', { file_path: 'C:\\outside\\note.txt' })

    expect(request.title).toBe('Read a file outside this project')
    expect(request.detail).toBe('C:\\outside\\note.txt')
  })

  it('shows the command itself for Bash — the thing the user is actually approving', () => {
    const request = describePermissionRequest('Bash', { command: 'rm -rf build' })

    expect(request.title).toBe('Run a command')
    expect(request.detail).toBe('rm -rf build')
  })

  it('matches the CLI\'s tool names case-insensitively', () => {
    expect(describePermissionRequest('bash', { command: 'ls' }).title).toBe('Run a command')
    expect(describePermissionRequest('WebFetch', { url: 'https://x.test' }).title).toBe('Fetch a web page')
  })

  it('still produces a decidable card for a tool it does not know', () => {
    const request = describePermissionRequest('SomeFutureTool', { target: 'thing' })

    expect(request.title).toBe('Use SomeFutureTool')
    expect(request.detail).toBe('thing')
  })

  it('reports no detail rather than an empty box when there is no subject', () => {
    expect(describePermissionRequest('Bash', {}).detail).toBeNull()
    expect(describePermissionRequest('Bash', { command: '   ' }).detail).toBeNull()
    expect(describePermissionRequest('Read', null).detail).toBeNull()
  })

  it('gives every request its own id, so two cards can never settle each other', () => {
    const a = describePermissionRequest('Read', { file_path: '/a' })
    const b = describePermissionRequest('Read', { file_path: '/a' })

    expect(a.id).not.toBe(b.id)
  })
})

describe('parsePermissionRequestInput', () => {
  it('accepts the relayed shape', () => {
    expect(parsePermissionRequestInput({ toolName: 'Read', input: { file_path: '/x' } })).not.toBeNull()
  })

  it('rejects anything without a toolName, so the caller can fail closed', () => {
    expect(parsePermissionRequestInput({ input: {} })).toBeNull()
    expect(parsePermissionRequestInput(null)).toBeNull()
    expect(parsePermissionRequestInput('Read')).toBeNull()
  })
})

describe('parking and settling', () => {
  it('resolves the waiter with the user\'s answer', async () => {
    const pending = awaitPermissionDecision('req-1')

    expect(settlePermissionDecision('req-1', { behavior: 'allow' })).toBe(true)

    expect(await pending).toEqual({ behavior: 'allow' })
    expect(__parkedPermissionPromptCount()).toBe(0)
  })

  it('carries a denial message through', async () => {
    const pending = awaitPermissionDecision('req-2')
    settlePermissionDecision('req-2', { behavior: 'deny', message: 'You declined this action.' })

    expect(await pending).toEqual({ behavior: 'deny', message: 'You declined this action.' })
  })

  it('ignores a second click on an already-answered prompt', async () => {
    const pending = awaitPermissionDecision('req-3')
    settlePermissionDecision('req-3', { behavior: 'allow' })

    expect(settlePermissionDecision('req-3', { behavior: 'deny' })).toBe(false)
    expect(await pending).toEqual({ behavior: 'allow' })
  })

  it('ignores an unknown id', () => {
    expect(settlePermissionDecision('never-parked', { behavior: 'allow' })).toBe(false)
  })

  it('keeps concurrent prompts independent', async () => {
    const first = awaitPermissionDecision('req-a')
    const second = awaitPermissionDecision('req-b')

    settlePermissionDecision('req-b', { behavior: 'allow' })
    settlePermissionDecision('req-a', { behavior: 'deny' })

    expect(await first).toEqual({ behavior: 'deny' })
    expect(await second).toEqual({ behavior: 'allow' })
  })

  // Without this a prompt whose turn died would hang forever, and the panel
  // would keep showing a card that nothing can answer.
  it('abandoning denies every parked prompt rather than leaving them hanging', async () => {
    const first = awaitPermissionDecision('req-x')
    const second = awaitPermissionDecision('req-y')

    abandonPermissionPrompts('You stopped the turn before answering.')

    expect(await first).toEqual({ behavior: 'deny', message: 'You stopped the turn before answering.' })
    expect(await second).toEqual({ behavior: 'deny', message: 'You stopped the turn before answering.' })
    expect(__parkedPermissionPromptCount()).toBe(0)
  })
})
