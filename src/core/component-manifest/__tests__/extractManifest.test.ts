import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractManifest } from '../extractManifest'

let appDir: string

function writeFixture(relativePath: string, contents: string): void {
  const fullPath = join(appDir, relativePath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, contents, 'utf8')
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'component-manifest-test-'))

  // Named export, exercises: required string prop, optional prop with a
  // default value, and a string-literal union prop (with its own default).
  writeFixture(
    'Card.tsx',
    `import * as React from 'react'

export interface CardProps {
  /** The card's heading text. */
  title: string
  subtitle?: string
  variant?: 'primary' | 'secondary'
}

export const Card: React.FC<CardProps> = ({ title, subtitle = 'Untitled', variant = 'primary' }) => {
  return (
    <div>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      <span>{variant}</span>
    </div>
  )
}
`,
  )

  // Default export, nested in a subdirectory, exercises relative/posix `file`
  // and default-export detection.
  writeFixture(
    'components/Button.tsx',
    `import * as React from 'react'

export interface ButtonProps {
  label: string
  disabled?: boolean
}

export default function Button({ label, disabled = false }: ButtonProps) {
  return <button disabled={disabled}>{label}</button>
}
`,
  )

  // Should be skipped entirely.
  writeFixture(
    'Card.test.tsx',
    `import * as React from 'react'
export const Ignored1: React.FC = () => <div />
`,
  )
  writeFixture(
    'Card.stories.tsx',
    `import * as React from 'react'
export const Ignored2: React.FC = () => <div />
`,
  )
  writeFixture(
    '__tests__/Ignored3.tsx',
    `import * as React from 'react'
export const Ignored3: React.FC = () => <div />
`,
  )
  writeFixture(
    'node_modules/some-pkg/Ignored4.tsx',
    `import * as React from 'react'
export const Ignored4: React.FC = () => <div />
`,
  )
})

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true })
})

describe('extractManifest', () => {
  it('only includes components from non-excluded .tsx files', () => {
    const manifest = extractManifest(appDir)
    const names = manifest.components.map((c) => c.name).sort()
    expect(names).toEqual(['Button', 'Card'])
  })

  it('captures a required string prop', () => {
    const manifest = extractManifest(appDir)
    const card = manifest.components.find((c) => c.name === 'Card')!
    const title = card.props.find((p) => p.name === 'title')!
    expect(title.tsType).toBe('string')
    expect(title.required).toBe(true)
    expect(title.defaultValue).toBeUndefined()
    expect(title.description).toBe("The card's heading text.")
  })

  it('captures an optional prop with a default value', () => {
    const manifest = extractManifest(appDir)
    const card = manifest.components.find((c) => c.name === 'Card')!
    const subtitle = card.props.find((p) => p.name === 'subtitle')!
    expect(subtitle.required).toBe(false)
    expect(subtitle.defaultValue).toBe('Untitled')
  })

  it('captures a string-literal union prop as enumValues, with its default', () => {
    const manifest = extractManifest(appDir)
    const card = manifest.components.find((c) => c.name === 'Card')!
    const variant = card.props.find((p) => p.name === 'variant')!
    expect(variant.required).toBe(false)
    expect(variant.enumValues).toEqual(['primary', 'secondary'])
    expect(variant.defaultValue).toBe('primary')
  })

  it('reports a relative, POSIX-separated file path', () => {
    const manifest = extractManifest(appDir)
    const card = manifest.components.find((c) => c.name === 'Card')!
    const button = manifest.components.find((c) => c.name === 'Button')!
    expect(card.file).toBe('Card.tsx')
    expect(button.file).toBe('components/Button.tsx')
    expect(card.file.includes('\\')).toBe(false)
    expect(button.file.includes('\\')).toBe(false)
  })

  it('detects named vs default exports', () => {
    const manifest = extractManifest(appDir)
    const card = manifest.components.find((c) => c.name === 'Card')!
    const button = manifest.components.find((c) => c.name === 'Button')!

    expect(card.isDefaultExport).toBe(false)
    expect(card.exportName).toBe('Card')

    expect(button.isDefaultExport).toBe(true)
    expect(button.exportName).toBe('default')
  })

  it('returns an empty manifest for a directory with no .tsx files', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'component-manifest-empty-'))
    try {
      const manifest = extractManifest(emptyDir)
      expect(manifest.components).toEqual([])
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
