/**
 * IconsSection — the project's icon catalogue inside the Assets panel.
 *
 * Reads the same client cache the slot picker does (`fetchStudioIconCatalog`,
 * one fetch per project, ~hundreds of KB because the response carries each
 * icon's markup) and sanitises the same way (`sanitizeSvg` before anything is
 * rendered — the panel is same-origin `/admin` chrome, so it is its own trust
 * boundary and does not get to assume the server already checked).
 *
 * **Clicking an icon copies its markup**, it does not insert a node. That is
 * the honest action here: an icon in this design system is a `<FooIcon/>` a
 * component's icon PROP takes (the slot picker's job, where a target prop
 * exists), or SVG markup pasted into source. The Assets panel has no slot
 * selected and no honest `base.*` module to write an inline SVG into
 * (`moduleAvailability` hides `base.svg` — it has no `sourceIntrinsic`), so
 * offering an "insert" would be offering a refusal. The tooltip says "Copy".
 *
 * The catalogue is fetched lazily — on first expand, never on panel open — so
 * opening Assets costs nothing for a project whose icons you never look at.
 */
import { useEffect, useRef, useState } from 'react'
import { sanitizeSvg } from '@core/sanitize'
import { getErrorMessage } from '@core/utils/errorMessage'
import { fetchStudioIconCatalog, type StudioIcon } from '@site/studio/iconCatalog'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { pushToast } from '@ui/components/Toast'
import { AssetSection } from './AssetSection'
import { queryTokens } from './rankAssets'
import styles from './AssetsPanel.module.css'

/** How many icons render at once. The set runs to several hundred; search reaches the rest. */
const VISIBLE_LIMIT = 120

interface IconsSectionProps {
  query: string
  collapsed: boolean
  onToggle: () => void
}

export function IconsSection({ query, collapsed, onToggle }: IconsSectionProps) {
  const [icons, setIcons] = useState<StudioIcon[] | null>(null)
  // A ref, not state: "we have already asked" is a fact about this mount, and
  // flipping it in the effect body would be a synchronous setState in an
  // effect (cascading render) for a value nothing renders.
  const requested = useRef(false)

  // Fetch on first expand. `fetchStudioIconCatalog` caches per project, so a
  // collapse/expand cycle — or the slot picker having already asked — costs
  // nothing.
  useEffect(() => {
    if (collapsed || requested.current) return
    requested.current = true
    let cancelled = false
    void fetchStudioIconCatalog().then((list) => {
      if (!cancelled) setIcons(list)
    })
    return () => {
      cancelled = true
    }
  }, [collapsed])

  const tokens = queryTokens(query)
  const matches = (icons ?? []).filter((icon) =>
    tokens.every(
      (token) =>
        icon.name.toLowerCase().includes(token) || icon.group.toLowerCase().includes(token),
    ),
  )
  const visible = matches.slice(0, VISIBLE_LIMIT)

  async function copyIcon(icon: StudioIcon) {
    try {
      await navigator.clipboard.writeText(sanitizeSvg(icon.markup))
      pushToast({ kind: 'success', title: `Copied ${icon.name}`, body: 'SVG markup is on your clipboard.' })
    } catch (err) {
      console.error('[AssetsPanel] copy icon failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not copy that icon',
        body: getErrorMessage(err, 'Clipboard access was refused'),
      })
    }
  }

  return (
    <AssetSection
      title="Icons"
      count={icons === null ? 0 : matches.length}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {icons === null ? (
        <EmptyState plain compact title="Loading icons…" />
      ) : visible.length === 0 ? (
        <EmptyState
          plain
          compact
          title="No icons"
          description="Studio offers the icons your installed design system ships as files."
        />
      ) : (
        <>
          <div className={styles.iconGrid}>
            {visible.map((icon) => (
              <Button
                key={icon.id}
                variant="ghost"
                iconOnly
                className={styles.iconTile}
                aria-label={`Copy ${icon.name} SVG markup`}
                tooltip={`Copy ${icon.name}`}
                onClick={() => void copyIcon(icon)}
              >
                <span
                  className={styles.iconGlyph}
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: sanitizeSvg(icon.markup) }}
                />
              </Button>
            ))}
          </div>
          {matches.length > visible.length && (
            <p className={styles.iconCount}>
              Showing {visible.length} of {matches.length} — keep typing to narrow it down.
            </p>
          )}
        </>
      )}
    </AssetSection>
  )
}
