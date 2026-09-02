/**
 * ContentPanel — every string in the project, in every locale it declares,
 * side by side and editable.
 *
 * ## Where the rows come from
 *
 * The project's OWN dictionary (`server/handlers/studio/translationCatalog.ts`),
 * not a Studio-side store. That is the whole design: Studio's premise is that
 * the repository is the document, so a translation edited here is a real edit
 * to `src/i18n/translations.ts` (or `locales/ar.json`) and ships with the
 * user's app. A sidecar would have shown Arabic on the canvas that never
 * existed in production.
 *
 * "Maps all the content automatically" is therefore not a scan Studio
 * performs — it is what a dictionary already IS. Every key the project
 * defines becomes a row, nested keys flattened to `nav.home`, with one column
 * per declared locale.
 *
 * ## Every project gets English and Arabic, without being asked twice
 *
 * A project with no dictionary at all is not shown a button and left there:
 * opening this panel IS the request, so the setup runs on its own
 * (`server/handlers/studio/i18nSetup.ts`) — scaffolding a real `i18n/` module
 * and rewriting the hardcoded copy to read from it. That write is structural
 * and it touches the user's source, so it is reported in full (how many
 * strings, how many files, every refusal) and it is attempted exactly ONCE per
 * mount: a refusal shows its reason and an explicit retry rather than
 * re-running a source rewrite on every render.
 *
 * ## Three honest states, not one empty list
 *
 * - **No dictionary** — setting one up, or, if that was refused, the reason
 *   plus the copy that is still inline and therefore still untranslatable.
 * - **A key still untranslated** — either the cell is empty (the normal
 *   starting state) or it holds the SOURCE string handed back unchanged, which
 *   a model routinely does for a bare product-ish noun. Both are what the
 *   filter and the translate action target; `isUntranslated` (`@core/i18n`) is
 *   the single rule they share, so a row the panel counts is always a row the
 *   action can clear. Counting only empty cells hid four keys on a real
 *   project behind "Missing ar (0)" while an Arabic sheet rendered a Latin
 *   `Sheet2` at the top of it.
 * - **A value that is code** — the write refuses with the reason from the
 *   server (`"holds an expression, not a plain string"`), surfaced as a toast.
 *   The panel never silently drops an edit.
 *
 * ## Strings still inline are shown even once a dictionary exists
 *
 * Having a dictionary does not mean every string is IN it: a screen written
 * after the last extraction, a literal the scanner learned to see later, and
 * anything a rewrite refused are all still hardcoded. The panel listed them
 * only in the no-dictionary state at first, which meant that the moment the
 * dictionary existed they became invisible — present in the payload, absent
 * from the UI. They now sit under the table with the same action, so "what is
 * translatable" and "what is not yet" are both answerable from one place.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  fetchContentSnapshot,
  setUpProjectLocales,
  translateMissing,
  writeTranslation,
  type ContentSnapshot,
} from '@site/studio/translationCatalogClient'
import { isUntranslated } from '@core/i18n'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import styles from './ContentPanel.module.css'

/** The locale a project is being translated INTO by the AI action. Arabic is the ask; a project declaring more locales still edits all of them by hand. */
const TARGET_LOCALE = 'ar'

/** Locales written right-to-left — their cells get `dir="rtl"` so the text reads the way it will render. */
const RTL_LOCALES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur'])

const EMPTY_SNAPSHOT: ContentSnapshot = { catalog: null, hardcoded: [] }

/** Fetches the content snapshot, turning a failure into the empty one plus a toast — the panel never shows a blank screen. */
async function readSnapshot(): Promise<ContentSnapshot> {
  try {
    return await fetchContentSnapshot()
  } catch (err) {
    console.error('[ContentPanel] content fetch failed:', err)
    pushToast({ kind: 'error', title: 'Could not read content', body: getErrorMessage(err, 'Unknown error') })
    return EMPTY_SNAPSHOT
  }
}

export function ContentPanel() {
  const [snapshot, setSnapshot] = useState<ContentSnapshot | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [untranslatedOnly, setUntranslatedOnly] = useState(false)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [settingUp, setSettingUp] = useState(false)
  const [setupRefusal, setSetupRefusal] = useState<string | null>(null)
  // A source rewrite must not be retried on every render, so the attempt is
  // tracked outside React state — a ref, not a dependency.
  const setupAttempted = useRef(false)

  async function load() {
    setSnapshot(await readSnapshot())
  }

  /**
   * Scaffolds the project's dictionary and moves every hardcoded string into
   * it. Structural — it rewrites the user's JSX — so the result is reported
   * with the file count, and any per-string refusal is named rather than
   * folded into a success.
   */
  // `useCallback` is exception 1 in CLAUDE.md's memoization rule: this is read
  // from a `useEffect` dependency array, where the static lint rule cannot see
  // the compiler's runtime memoization. It closes over nothing but setters, so
  // the empty dep list is honest and the effect never re-runs because of it.
  const runSetup = useCallback(async () => {
    setSettingUp(true)
    setSetupRefusal(null)
    try {
      const result = await setUpProjectLocales()
      if (!result.ok) {
        setSetupRefusal(result.message)
        pushToast({ kind: 'error', title: 'Could not set up locales', body: result.message })
        return
      }
      setSnapshot(await readSnapshot())
      pushToast({
        kind: result.failures.length > 0 ? 'warning' : 'success',
        title: `${result.extracted} strings now translatable`,
        body: [
          `${result.locales.join(' + ')} in ${result.source}, across ${result.filesChanged} ${result.filesChanged === 1 ? 'file' : 'files'}.`,
          result.failures.length > 0 ? `${result.failures.length} left in place: ${result.failures[0]!.message}` : null,
        ]
          .filter((note): note is string => note !== null)
          .join(' '),
      })
    } catch (err) {
      const message = getErrorMessage(err, 'Unknown error')
      setSetupRefusal(message)
      pushToast({ kind: 'error', title: 'Setup failed', body: message })
    } finally {
      setSettingUp(false)
    }
  }, [])

  // `load()` is async, so every state write inside it lands after an await —
  // never synchronously during the effect. The lint rule cannot see through the
  // promise, and `useState(() => …)` is not an option because the initial value
  // is fetched, so the call is wrapped to keep the effect body free of a
  // direct state write.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next = await readSnapshot()
      if (cancelled) return
      setSnapshot(next)
      // Opening this panel on a project with no localisation IS the request
      // for it — see the module doc. Guarded so it happens once.
      if (next.catalog === null && next.hardcoded.length > 0 && !setupAttempted.current) {
        setupAttempted.current = true
        await runSetup()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runSetup])

  async function commit(key: string, locale: string, value: string) {
    setSavingKey(`${locale}:${key}`)
    try {
      const result = await writeTranslation({ locale, key, value })
      if (!result.ok) {
        pushToast({ kind: 'error', title: `Could not write ${key}`, body: result.message })
        return
      }
      // Re-read rather than patching local state: the file is the source of
      // truth, and a write can normalise what it stored.
      await load()
    } catch (err) {
      pushToast({ kind: 'error', title: 'Save failed', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setSavingKey(null)
    }
  }

  /**
   * Fills every missing target-locale value in one model call. Reports a
   * partial result as a partial result: a key the model omitted and a key the
   * write refused are different outcomes and both are named, rather than
   * rounding up to "done".
   */
  async function runTranslate() {
    setTranslating(true)
    try {
      const result = await translateMissing({ targetLocale: TARGET_LOCALE })
      await load()
      const notes = [
        result.skipped.length > 0 ? `${result.skipped.length} skipped by the model` : null,
        result.failures.length > 0 ? `${result.failures.length} refused: ${result.failures[0]!.message}` : null,
        result.remaining > 0 ? `${result.remaining} left — run it again to continue` : null,
      ].filter((note): note is string => note !== null)
      pushToast({
        kind: result.failures.length > 0 ? 'warning' : 'success',
        title: `Translated ${result.translated} ${result.translated === 1 ? 'string' : 'strings'}`,
        body: notes.join(' · ') || 'Written into the dictionary.',
      })
    } catch (err) {
      pushToast({ kind: 'error', title: 'Translation failed', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setTranslating(false)
    }
  }

  if (snapshot === undefined) {
    return <p className={styles.empty}>Loading content…</p>
  }
  const { catalog, hardcoded } = snapshot

  if (catalog === null) {
    return (
      <SetupState
        busy={settingUp}
        refusal={setupRefusal}
        hardcoded={hardcoded}
        onRetry={() => void runSetup()}
      />
    )
  }

  const locales = catalog.capability.keys
  // The dictionary's own default locale is the source the AI translates FROM,
  // so it is also what an untranslated cell is compared against — see
  // `isUntranslated`. Falling back to the first declared locale mirrors the
  // server's own resolution in `translateContent.ts`.
  const sourceLocale = catalog.capability.defaultKey ?? catalog.capability.keys[0]
  const needsTranslating = (entry: { values: Record<string, string> }) =>
    isUntranslated(sourceLocale ? entry.values[sourceLocale] : undefined, entry.values[TARGET_LOCALE])
  const needle = query.trim().toLowerCase()
  const rows = catalog.entries.filter((entry) => {
    if (untranslatedOnly && !needsTranslating(entry)) return false
    if (!needle) return true
    return (
      entry.key.toLowerCase().includes(needle) ||
      Object.values(entry.values).some((value) => value.toLowerCase().includes(needle))
    )
  })
  const missing = catalog.entries.filter(needsTranslating).length

  // The column template is data-driven — a project may declare more than two
  // locales — so it is set as a custom property the stylesheet reads back,
  // which is the one inline-style shape this codebase allows.
  const gridStyle = {
    '--content-columns': `minmax(84px, 0.7fr) repeat(${locales.length}, minmax(0, 1fr))`,
  } as CSSProperties

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        {/*
          The translate action sits beside the search box, not below the
          filter chip: it is the reason this panel exists, and a primary
          action buried under a row of chips reads as an afterthought.
        */}
        <div className={styles.searchRow}>
          <div className={styles.searchField}>
            <SearchBar value={query} onValueChange={setQuery} placeholder="Search keys and text…" aria-label="Search content" />
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={missing === 0 || translating}
            tooltip={missing === 0 ? `Every key already has ${TARGET_LOCALE}.` : `Fill in the ${missing} untranslated ${TARGET_LOCALE} strings with AI.`}
            onClick={() => void runTranslate()}
            data-testid="content-panel-translate"
          >
            {translating ? 'Translating…' : `Translate → ${TARGET_LOCALE}`}
          </Button>
        </div>
        <div className={styles.toolbarRow}>
          <Button
            variant={untranslatedOnly ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => setUntranslatedOnly((v) => !v)}
            data-testid="content-panel-filter-untranslated"
          >
            {/* "Untranslated", not "Missing": a cell holding the English word
                back is not missing, and calling it that is how four keys stayed
                invisible. */}
            Untranslated {TARGET_LOCALE} ({missing})
          </Button>
          <p className={styles.source}>
            {catalog.entries.length} keys · {catalog.capability.source}
          </p>
        </div>
      </div>

      {hardcoded.length > 0 ? (
        <InlineStrings hardcoded={hardcoded} busy={settingUp} onExtract={() => void runSetup()} />
      ) : null}

      <div className={styles.tableScroll}>
        <div className={styles.table} style={gridStyle} role="table" data-testid="content-panel-rows">
          <div className={styles.headerRow} role="row">
            <span className={styles.headerCell} role="columnheader">
              Key
            </span>
            {locales.map((locale) => (
              <span key={locale} className={styles.headerCell} role="columnheader">
                {locale}
              </span>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className={styles.empty}>Nothing matched.</p>
          ) : (
            rows.map((entry) => (
              <div key={entry.key} className={styles.row} role="row">
                <span className={styles.key} title={entry.key} role="cell">
                  {entry.key}
                </span>
                {locales.map((locale) => (
                  <LocaleCell
                    // Keyed on the value so a re-read that CHANGED this cell
                    // remounts it, and one that did not leaves an in-progress
                    // edit alone.
                    key={`${locale}:${entry.values[locale] ?? ''}`}
                    locale={locale}
                    value={entry.values[locale] ?? ''}
                    busy={savingKey === `${locale}:${entry.key}`}
                    onCommit={(next) => void commit(entry.key, locale, next)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The copy that is still written into the JSX, on a project that already has a
 * dictionary. Collapsed to a one-line summary plus the action, because on a
 * healthy project this is empty and on an unhealthy one it must not push the
 * table — the thing the panel is FOR — off the screen.
 */
function InlineStrings({
  hardcoded,
  busy,
  onExtract,
}: {
  hardcoded: ContentSnapshot['hardcoded']
  busy: boolean
  onExtract: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className={styles.inlineStrings} data-testid="content-panel-inline">
      <div className={styles.inlineHeader}>
        <Button variant="ghost" size="xs" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {hardcoded.length} {hardcoded.length === 1 ? 'string' : 'strings'} still in the code
        </Button>
        <Button variant="secondary" size="xs" disabled={busy} onClick={onExtract} data-testid="content-panel-extract">
          {busy ? 'Moving…' : 'Move into dictionary'}
        </Button>
      </div>
      {open ? (
        <div className={styles.rows}>
          {hardcoded.map((item) => (
            <div key={`${item.file}:${item.line}:${item.col}`} className={styles.literalRow}>
              <span className={styles.key} title={`${item.file}:${item.line}`}>
                {item.file.split('/').pop()}:{item.line} · {item.prop ?? 'text'}
              </span>
              <span className={styles.literal}>{item.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * What a project with no dictionary shows: the setup running, or — if it was
 * refused — why, plus the copy that is consequently still inline. The list
 * stays read-only in the refusal case for the original reason: with no
 * dictionary there is nowhere to write a translation, so an input here would
 * be a control that lies.
 */
function SetupState({
  busy,
  refusal,
  hardcoded,
  onRetry,
}: {
  busy: boolean
  refusal: string | null
  hardcoded: ContentSnapshot['hardcoded']
  onRetry: () => void
}) {
  if (busy) {
    return (
      <p className={styles.empty} data-testid="content-panel-setting-up">
        Setting up English + Arabic — adding an <code>i18n/</code> module and moving {hardcoded.length}{' '}
        strings into it…
      </p>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <p className={styles.emptyTitle}>
          {refusal ? 'Could not set up locales' : 'No locale dictionary in this project'}
        </p>
        <p className={styles.note}>
          {refusal ??
            'Studio writes translations your app actually ships, so it needs a real dictionary. Setting one up adds an i18n/ module to this project and rewrites these strings to read from it.'}
        </p>
        <Button variant="primary" size="xs" onClick={onRetry} data-testid="content-panel-setup">
          Set up English + Arabic
        </Button>
      </div>
      <div className={styles.rows} data-testid="content-panel-hardcoded">
        {hardcoded.map((item) => (
          <div key={`${item.file}:${item.line}:${item.col}`} className={styles.literalRow}>
            <span className={styles.key} title={`${item.file}:${item.line}`}>
              {item.file.split('/').pop()}:{item.line} · {item.prop ?? 'text'}
            </span>
            <span className={styles.literal}>{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * One locale's value for one key. Commits on blur (and on Enter) rather than
 * per keystroke — each commit is a real write into the user's source file,
 * and a write per character would rewrite the dictionary hundreds of times
 * for one sentence.
 */
function LocaleCell({
  locale,
  value,
  busy,
  onCommit,
}: {
  locale: string
  value: string
  busy: boolean
  onCommit: (value: string) => void
}) {
  // No re-sync effect: the parent keys this component on its own value — see
  // there. That is the same outcome a `useEffect` sync would produce, without
  // a render-cascading state write, and it cannot fight the user mid-keystroke.
  const [draft, setDraft] = useState(value)

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      disabled={busy}
      dir={RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'}
      placeholder={value === '' ? `No ${locale}` : undefined}
      aria-label={`${locale} value`}
      className={styles.cell}
    />
  )
}
