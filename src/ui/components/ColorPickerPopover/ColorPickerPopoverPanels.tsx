/**
 * `ColorPickerPopover`'s Tokens tab and "On this page" recents strip — split
 * out of `ColorPickerPopover.tsx` to stay under this repo's per-module line
 * budget (`module-size-budgets.test.ts`). Internal to this component folder;
 * not part of the public barrel.
 */
import { useState, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { cn } from '@ui/cn'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import type { ColorPickerToken } from './types'
import styles from './ColorPickerPopover.module.css'

export type PickerStyle = CSSProperties & Record<`--${string}`, string | number>

export function TokensPanel({
  tokens,
  appliedTokenId,
  onPick,
  onPreview,
  onClearPreview,
}: {
  tokens: ReadonlyArray<ColorPickerToken>
  appliedTokenId: string | undefined
  onPick: (value: string) => void
  onPreview: ((value: string) => void) | undefined
  onClearPreview: (() => void) | undefined
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const filtered = q === ''
    ? tokens
    : tokens.filter((t) => t.name.toLowerCase().includes(q) || (t.meta?.toLowerCase().includes(q) ?? false))

  return (
    <div className={styles.tokensPanel}>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tokens…"
        aria-label="Search colour tokens"
        fieldSize="sm"
      />
      <div className={styles.tokenList} role="listbox" aria-label="Colour tokens" onMouseLeave={() => onClearPreview?.()}>
        {filtered.map((token) => {
          const active = token.id === appliedTokenId
          return (
            <Button
              key={token.id}
              type="button"
              variant="ghost"
              menuItem
              fullWidth
              align="start"
              aria-selected={active}
              role="option"
              className={cn(styles.tokenRow, active && styles.tokenRowActive)}
              onMouseEnter={() => onPreview?.(`var(${token.name})`)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(`var(${token.name})`)}
            >
              <span
                className={styles.swatch}
                style={{ '--picker-swatch-value': token.value } as PickerStyle}
                aria-hidden="true"
              />
              <span className={styles.tokenText}>
                <span className={styles.tokenName}>{token.name}</span>
                {token.meta && <span className={styles.tokenMeta}>{token.meta}</span>}
              </span>
              {active && <CheckIcon size={12} aria-hidden="true" />}
            </Button>
          )
        })}
        {filtered.length === 0 && <p className={styles.tokenEmpty}>No matching tokens.</p>}
      </div>
    </div>
  )
}

export function RecentsStrip({
  colors,
  onPick,
}: {
  colors: ReadonlyArray<string> | undefined
  onPick: (value: string) => void
}) {
  if (!colors || colors.length === 0) return null
  return (
    <div className={styles.recents}>
      <span className={styles.recentsLabel}>On this page</span>
      <div className={styles.recentsRow}>
        {colors.map((color, index) => (
          <Button
            key={`${color}-${index}`}
            type="button"
            variant="ghost"
            size="micro"
            iconOnly
            aria-label={`Apply ${color}`}
            tooltip={color}
            className={styles.recentSwatchButton}
            onClick={() => onPick(color)}
          >
            <span
              className={styles.swatch}
              style={{ '--picker-swatch-value': color } as PickerStyle}
              aria-hidden="true"
            />
          </Button>
        ))}
      </div>
    </div>
  )
}
