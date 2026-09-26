import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * AI-7 — an agent turn you can undo, end to end in a real browser.
 *
 * No provider key: the "model" is a local fake of an OpenAI-compatible server
 * behind an Ollama credential, so the turn runs through the REAL HTTP tool
 * loop, Studio's REAL file tools (`studio_edit_file`), the real checkpoint
 * capture, the real panel and the real revert route. The fake decides only
 * what the model says: two `studio_edit_file` calls, then "Done."
 *
 * The claims, each read back off the filesystem:
 *
 *   1. A turn that writes two files shows "Changed 2 files", and "Revert turn"
 *      restores BOTH byte-identically.
 *   2. A file the user edited after the turn is refused by name: "Revert turn"
 *      writes nothing; the untouched file still reverts on its own; the edited
 *      one keeps the user's edit.
 */

const FIXTURE_NAME = '__e2e-agent-turn-revert'
const HOME = 'export default function Home() {\n  return <h1 className="title">Welcome home</h1>\n}\n'
const ABOUT = 'export default function About() {\n  return <p className="lede">About this studio</p>\n}\n'

let fixture: FixtureProject
let fakeModel: { baseUrl: string; close(): Promise<void> } | null = null
let credentialId: string | null = null
let previousDefault: { credentialId: string; modelId: string } | null = null

/** The two edits the fake model asks for, every turn: change a word in each page. */
function editCalls(turn: number) {
  return [
    { id: `call_home_${turn}`, name: 'studio_edit_file', input: { path: 'pages/Home.tsx', oldString: 'Welcome home', newString: `Welcome back ${turn}` } },
    { id: `call_about_${turn}`, name: 'studio_edit_file', input: { path: 'pages/About.tsx', oldString: 'About this studio', newString: `About us ${turn}` } },
  ]
}

async function startFakeModel(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let turn = 0
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'e2e-model' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ role: string }> }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        // After the tool results come back, the model says it is done.
        if (body.messages.at(-1)?.role === 'tool') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`)
          res.end('data: [DONE]\n\n')
          return
        }
        turn += 1
        const calls = editCalls(turn)
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: calls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            },
            finish_reason: null,
          }],
        })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The fake model server did not bind a port.')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A same-origin authenticated request from inside the page. */
async function requestJson(page: Page, url: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ target, verb, payload }: { target: string; verb: string; payload: unknown }) => {
      const res = await fetch(target, {
        method: verb,
        credentials: 'same-origin',
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      })
      const text = await res.text()
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null }
    },
    { target: url, verb: method, payload: body },
  )
}

function read(rel: string): Buffer {
  return fs.readFileSync(path.join(fixture.dir, ...rel.split('/')))
}

test.beforeAll(async () => {
  fixture = createAuthoredFixtureProject(FIXTURE_NAME, {
    'pages/Home.tsx': HOME,
    'pages/About.tsx': ABOUT,
    '.studio/meta.json': '{"trust":"static"}\n',
  })
  fakeModel = await startFakeModel()
})

test.afterAll(async () => {
  if (fakeModel) await fakeModel.close()
  if (fixture) removeFixtureProject(fixture)
})

test.afterEach(async ({ page }) => {
  try {
    // Leave the owner's AI setup exactly as it was: the default, and no stray credential.
    if (previousDefault) await requestJson(page, '/admin/api/ai/defaults', 'PUT', previousDefault)
    else await requestJson(page, '/admin/api/ai/defaults', 'DELETE')
    if (credentialId) await requestJson(page, `/admin/api/ai/credentials/${credentialId}`, 'DELETE')
  } catch {
    // The page may never have navigated.
  }
})

test('an agent turn that wrote two files reverts byte-identically; a file the user edited since is refused', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/admin/dashboard')

  const before = await requestJson(page, '/admin/api/ai/defaults', 'GET')
  previousDefault = (before.body as { default?: { credentialId: string; modelId: string } | null }).default ?? null
  const created = await requestJson(page, '/admin/api/ai/credentials', 'POST', {
    providerId: 'ollama',
    authMode: 'baseUrl',
    displayLabel: 'E2E fake model (agent revert)',
    baseUrl: fakeModel!.baseUrl,
  })
  expect(created.status, `creating the fake-model credential answered ${created.status}`).toBeLessThan(300)
  credentialId = (created.body as { credential: { id: string } }).credential.id
  const setDefault = await requestJson(page, '/admin/api/ai/defaults', 'PUT', { credentialId, modelId: 'e2e-model' })
  expect(setDefault.status).toBeLessThan(300)

  await openFixtureBoard(page, fixture, { autoSave: false })
  await page.getByRole('button', { name: 'Open AI assistant panel' }).click()
  const panel = page.getByRole('complementary', { name: 'AI Assistant' })
  const composer = panel.getByLabel('Message to AI assistant')
  await expect(composer).toBeEditable({ timeout: 30_000 })

  const homeBefore = read('pages/Home.tsx')
  const aboutBefore = read('pages/About.tsx')

  await test.step('turn 1 writes two files; Revert turn restores both, byte for byte', async () => {
    await composer.fill('Change the two headlines.')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    const card = panel.getByTestId('agent-turn-changes').last()
    await expect(card).toContainText('Changed 2 files', { timeout: 60_000 })
    expect(read('pages/Home.tsx').toString()).toContain('Welcome back 1')
    expect(read('pages/About.tsx').toString()).toContain('About us 1')

    await card.getByRole('button', { name: 'Revert turn' }).click()
    await expect(card).toContainText('Reverted', { timeout: 30_000 })
    expect(read('pages/Home.tsx').equals(homeBefore)).toBe(true)
    expect(read('pages/About.tsx').equals(aboutBefore)).toBe(true)
  })

  await test.step('turn 2: the user edits one file afterwards — that file is refused, the other still reverts', async () => {
    await composer.fill('Change them again.')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    const card = panel.getByTestId('agent-turn-changes').last()
    await expect(card).toContainText('Changed 2 files', { timeout: 60_000 })
    const homeAgent = read('pages/Home.tsx')

    const userEdit = read('pages/About.tsx').toString().replace('About us 2', 'About us, edited by hand')
    fs.writeFileSync(path.join(fixture.dir, 'pages', 'About.tsx'), userEdit)

    await card.getByRole('button', { name: 'Revert turn' }).click()
    await expect(card.getByRole('status')).toContainText('About.tsx', { timeout: 30_000 })
    await expect(card.getByRole('status')).toContainText('changed after this turn wrote it')
    expect(read('pages/Home.tsx').equals(homeAgent)).toBe(true)
    expect(read('pages/About.tsx').toString()).toBe(userEdit)

    await card.getByRole('button', { name: 'Revert pages/Home.tsx' }).click()
    await expect(card.getByRole('status')).toContainText('Reverted pages/Home.tsx', { timeout: 30_000 })
    expect(read('pages/Home.tsx').equals(homeBefore)).toBe(true)
    expect(read('pages/About.tsx').toString()).toBe(userEdit)
  })
})
