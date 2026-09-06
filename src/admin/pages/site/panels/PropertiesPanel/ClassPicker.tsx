/** ClassPicker — selector chip manager for the selected element. */

import {
  useState,
  useReducer,
  useRef,
  useEffect,
  useImperativeHandle,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { classifySelectorCreateInput, isSourceDerivedNodeId, styleRuleSelector, type StyleRule } from '@core/page-tree'
import { recordClassUsage } from '@site/preferences/classUsage'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  deriveSelectorPickerModel,
  type SelectorPillItem,
  type SelectorSuggestionItem,
} from './selectorPickerModel'
import {
  SelectorInputArea,
  SelectorPillStack,
  SelectorSuggestionsPortal,
  UnmatchedSelectorNotice,
} from './ClassPickerParts'
import { classPickerUiReducer, initialClassPickerUiState } from './classPickerUiState'
import { escapeCssAttributeValue } from '@site/canvas/canvasNodeLookup'
import { useClassPickerDerivedState } from './useClassPickerDerivedState'
import { PillContextMenuPortal } from './ClassPillContextMenu'
import { ClassRenameDialog } from './ClassRenameDialog'
import styles from './ClassPicker.module.css'

interface UnmatchedSelectorNoticeState {
  ruleId: string
  selector: string
}

/**
 * The selector to auto-activate when a node is selected and nothing is active
 * yet: the highest-specificity *direct* match, skipping the universal `*`
 * (activating it on every element would be noise). Pills arrive sorted
 * weakest→strongest, so the strongest direct match is the last one.
 *
 * This restores click-to-edit for elements styled purely by ambient/descendant
 * selectors (e.g. `.hero-title em`) — they carry no own class, so the
 * store-level selection logic (which only reads `node.classIds`) can't pick
 * them up.
 */
function pickAutoActiveSelectorId(pills: SelectorPillItem[]): string | null {
  for (let i = pills.length - 1; i >= 0; i--) {
    const pill = pills[i]
    if (pill.match.kind !== 'direct') continue
    if (styleRuleSelector(pill.rule).trim() === '*') continue
    return pill.rule.id
  }
  return null
}

/**
 * The node association a class created from THIS picker carries, or
 * `undefined` when there is nothing honest to associate it with.
 *
 * A class created here is always created while an element is selected, and
 * `styleRuleWriteback.ts`'s `resolveCssInsertDestination` reads exactly this
 * `scope.nodeId` — through `decodeSourceNodeId` — to work out which PAGE the
 * class belongs to, and therefore which stylesheet its first declarations
 * should be co-located with. Without it, that resolver falls back to counting
 * stylesheets across the whole workspace and refuses any project with more
 * than one ("Studio found N candidate stylesheets ... and will not guess") —
 * i.e. every real multi-page project, where each page owns its own
 * `*.module.css`. The rule was created for a specific element on a specific
 * page the entire time; the scope is simply saying so.
 *
 * Restricted to a STUDIO source-derived node id (`rel:line:col`, the only ids
 * `decodeSourceNodeId` can name a file from) on purpose. A CMS nanoid node id
 * decodes to nothing, so a scope built from one buys the resolver nothing —
 * while still costing the two semantics `scope` carries elsewhere: a
 * node-scoped class is CLONED rather than shared when its node is duplicated
 * (`duplicateWithScopedClasses.ts`), and is claimed by
 * `ensureNodeStyleClass` as that node's module-style layer. A reusable
 * `.card` the user named themselves must not silently acquire either of
 * those behaviours in exchange for nothing.
 */
function nodeScopeForNewClass(nodeId: string): StyleRule['scope'] {
  return isSourceDerivedNodeId(nodeId)
    ? { type: 'node', nodeId, role: 'module-style' }
    : undefined
}

function keyboardMenuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + Math.min(rect.width - 8, 24),
    y: rect.top + Math.min(rect.height - 8, 24),
  }
}

export interface ClassPickerHandle {
  focusInput: () => void
}

interface ClassPickerProps {
  nodeId: string
  trailingAction?: ReactNode
  ref?: Ref<ClassPickerHandle>
}

export function ClassPicker({ nodeId, trailingAction, ref }: ClassPickerProps) {
  const site = useEditorStore((s) => s.site)
  const node = useEditorStore((s) => selectActiveCanvasPage(s)?.nodes[nodeId] ?? null)
  const activeClassId = useEditorStore((s) => s.activeClassId)
  const setActiveClass = useEditorStore((s) => s.setActiveClass)
  const inlineStyleEditing = useEditorStore((s) => s.inlineStyleEditing)
  const setInlineStyleEditing = useEditorStore((s) => s.setInlineStyleEditing)
  const clearNodeInlineStyles = useEditorStore((s) => s.clearNodeInlineStyles)
  const addNodeClass = useEditorStore((s) => s.addNodeClass)
  const removeNodeClass = useEditorStore((s) => s.removeNodeClass)
  const createClass = useEditorStore((s) => s.createClass)
  const createAmbientRule = useEditorStore((s) => s.createAmbientRule)
  const renameClass = useEditorStore((s) => s.renameClass)
  const reorderNodeClass = useEditorStore((s) => s.reorderNodeClass)
  const setPreviewNodeClass = useEditorStore((s) => s.setPreviewNodeClass)
  const clearPreviewNodeClass = useEditorStore((s) => s.clearPreviewNodeClass)
  const undo = useEditorStore((s) => s.undo)

  const [ui, dispatchUi] = useReducer(classPickerUiReducer, initialClassPickerUiState)
  const [unmatchedSelectorNotice, setUnmatchedSelectorNotice] =
    useState<UnmatchedSelectorNoticeState | null>(null)
  const { query, showSuggestions, contextMenu, renameTarget, createError, highlightedIndex } = ui
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')

  const inputRef = useRef<HTMLInputElement>(null)
  const inputRowRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({ focusInput: () => inputRef.current?.focus() }))

  const {
    visibleAssignedIds,
    showInlinePill,
    selectedElement,
    selectorModel,
    candidatesById,
    isEmptyQuery,
    filteredSuggestions,
    recentIds,
    frequentIds,
    remainingCandidates,
    shouldShowAllSection,
    surfacedCount,
    flatNavIds,
    highlightedClassId,
    highlightedSelectorItem,
    highlightedSelectorId,
    canCreateNew,
    hasSubmittableQuery,
    submitTooltip,
    exactMatchedClass,
    exactMatchAlreadyAssigned,
    exactMatchedSelectorItem,
    createIntent,
    createValidationError,
    selectorSuggestions,
    hasSuggestionRows,
  } = useClassPickerDerivedState({
    site,
    node,
    nodeId,
    activeClassId,
    inlineStyleEditing,
    query,
    highlightedIndex,
  })

  const contextClass = contextMenu ? site?.styleRules[contextMenu.classId] ?? null : null
  const contextClassIndex = contextMenu ? visibleAssignedIds.indexOf(contextMenu.classId) : -1

  const openSuggestions = () => dispatchUi({ type: 'openSuggestions' })

  const handleAddExisting = (classId: string) => {
    setUnmatchedSelectorNotice(null)
    addNodeClass(nodeId, classId)
    setActiveClass(classId)
    clearPreviewNodeClass(nodeId, classId)
    recordClassUsage(classId)
    dispatchUi({ type: 'resetAfterSubmit' })
  }

  const handleSelectAmbient = (item: SelectorSuggestionItem) => {
    if (item.disabled) return
    setUnmatchedSelectorNotice(null)
    setActiveClass(item.rule.id)
    dispatchUi({ type: 'resetAfterSubmit' })
  }

  const handleCreateAndAdd = () => {
    const intent = classifySelectorCreateInput(query)
    if (intent.kind === 'empty') return
    try {
      if (intent.kind === 'class') {
        setUnmatchedSelectorNotice(null)
        const newClass = createClass(intent.name, undefined, nodeScopeForNewClass(nodeId))
        addNodeClass(nodeId, newClass.id)
        setActiveClass(newClass.id)
        clearPreviewNodeClass(nodeId)
        recordClassUsage(newClass.id)
      } else {
        const newRule = createAmbientRule({ selector: intent.selector })
        const createdModel = deriveSelectorPickerModel({
          rules: { [newRule.id]: newRule },
          node,
          selectedElement,
          activeRuleId: null,
        })
        const createdSuggestion = createdModel.suggestions[0]
        if (createdSuggestion && !createdSuggestion.disabled) {
          setUnmatchedSelectorNotice(null)
          setActiveClass(newRule.id)
        } else {
          setUnmatchedSelectorNotice({ ruleId: newRule.id, selector: newRule.selector })
        }
      }
      dispatchUi({ type: 'resetAfterSubmit' })
    } catch (err) {
      dispatchUi({
        type: 'setCreateError',
        message: getErrorMessage(err, 'Unable to create selector').replace(/^\[[^\]]+\]\s*/, ''),
      })
    }
  }

  const submitQuery = () => {
    if (highlightedSelectorItem) {
      handleSelectAmbient(highlightedSelectorItem)
      return
    }
    if (highlightedClassId) {
      handleAddExisting(highlightedClassId)
      return
    }
    if (isEmptyQuery) return
    if (exactMatchedClass) {
      if (!exactMatchAlreadyAssigned) handleAddExisting(exactMatchedClass.id)
      return
    }
    if (exactMatchedSelectorItem) {
      handleSelectAmbient(exactMatchedSelectorItem)
      return
    }
    if (canCreateNew) handleCreateAndAdd()
  }

  const previewClass = (classId: string) => {
    if (!hoverPreviewEnabled) return
    setPreviewNodeClass(nodeId, classId)
  }

  const clearPreviewClass = (classId: string) => {
    clearPreviewNodeClass(nodeId, classId)
  }

  // Auto-activate the most specific matching selector when a fresh node is
  // selected and nothing is active yet. Keyed on `nodeId` (via the ref guard)
  // so it fires once per selection — a manual deactivation on the same node
  // stays deactivated rather than being immediately re-applied.
  const autoActivatedNodeRef = useRef<string | null>(null)
  useEffect(() => {
    if (autoActivatedNodeRef.current === nodeId) return
    // An assigned class (set by the store on selection) or inline-style editing
    // already supplies the edit target — nothing to auto-activate.
    if (activeClassId !== null || inlineStyleEditing) {
      autoActivatedNodeRef.current = nodeId
      return
    }
    // Wait until the live canvas element is resolved so ambient/descendant
    // selector matching is real before we commit to "nothing matches".
    if (!selectedElement) return
    autoActivatedNodeRef.current = nodeId
    const target = pickAutoActiveSelectorId(selectorModel.pills)
    if (target) setActiveClass(target)
  }, [nodeId, activeClassId, inlineStyleEditing, selectedElement, selectorModel, setActiveClass])

  useEffect(() => {
    if (!hoverPreviewEnabled) clearPreviewNodeClass(nodeId)
  }, [hoverPreviewEnabled, clearPreviewNodeClass, nodeId])

  useEffect(() => () => clearPreviewNodeClass(nodeId), [clearPreviewNodeClass, nodeId])

  useEffect(() => {
    const highlightedSuggestionId = highlightedClassId ?? highlightedSelectorId
    if (!highlightedSuggestionId) return
    const el = document.querySelector<HTMLElement>(
      `[data-selector-suggestion-id="${escapeCssAttributeValue(highlightedSuggestionId)}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightedClassId, highlightedSelectorId])

  const closeSuggestions = () => {
    clearPreviewNodeClass(nodeId)
    dispatchUi({ type: 'closeSuggestions' })
  }

  const closeContextMenu = () => {
    dispatchUi({ type: 'setContextMenu', contextMenu: null })
  }

  const openClassContextMenu = (classId: string, event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dispatchUi({
      type: 'setContextMenu',
      contextMenu: { x: event.clientX, y: event.clientY, classId },
    })
  }

  const openKeyboardClassContextMenu = (classId: string, event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    dispatchUi({
      type: 'setContextMenu',
      contextMenu: { ...keyboardMenuPosition(event.currentTarget), classId },
    })
  }

  const handleRename = (name: string) => {
    if (!renameTarget) return
    renameClass(renameTarget.id, name)
    dispatchUi({ type: 'setRenameTarget', renameTarget: null })
  }

  const removeAssignedClass = (classId: string) => {
    if (activeClassId === classId) setActiveClass(null)
    removeNodeClass(nodeId, classId)
  }

  const handleUndoUnmatchedSelector = () => {
    undo()
    setUnmatchedSelectorNotice(null)
  }

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitQuery()
      return
    }
    if (e.key === 'Escape') {
      closeSuggestions()
      return
    }
    if (e.key === 'ArrowDown') {
      if (flatNavIds.length === 0) return
      e.preventDefault()
      dispatchUi({ type: 'moveHighlight', direction: 'next', count: flatNavIds.length })
      return
    }
    if (e.key === 'ArrowUp') {
      if (flatNavIds.length === 0) return
      e.preventDefault()
      dispatchUi({ type: 'moveHighlight', direction: 'previous', count: flatNavIds.length })
    }
  }

  return (
    <div className={styles.container}>
      <PillContextMenuPortal
        contextMenu={contextMenu}
        contextClass={contextClass}
        contextClassIndex={contextClassIndex}
        visibleAssignedCount={visibleAssignedIds.length}
        onClose={closeContextMenu}
        onEdit={(c) => setActiveClass(c.id)}
        onRename={(c) => dispatchUi({ type: 'setRenameTarget', renameTarget: c })}
        onMove={(c, direction) => reorderNodeClass(nodeId, c.id, direction)}
        onRemove={(c) => removeAssignedClass(c.id)}
      />

      {renameTarget && (
        <ClassRenameDialog
          initialValue={renameTarget.name}
          onCancel={() => dispatchUi({ type: 'setRenameTarget', renameTarget: null })}
          onRename={handleRename}
        />
      )}

      <SelectorInputArea
        inputRowRef={inputRowRef}
        inputRef={inputRef}
        trailingAction={trailingAction}
        query={query}
        hasSubmittableQuery={hasSubmittableQuery}
        submitTooltip={submitTooltip}
        onQueryChange={(nextQuery) => {
          setUnmatchedSelectorNotice(null)
          dispatchUi({ type: 'inputChanged', query: nextQuery })
        }}
        onFocus={openSuggestions}
        onKeyDown={handleSearchKeyDown}
        onSubmit={submitQuery}
      >
        <SelectorSuggestionsPortal
          visibility={{
            open: showSuggestions,
            hasRows: hasSuggestionRows,
            canCreate: canCreateNew,
            emptyQuery: isEmptyQuery,
          }}
          sections={{ showAllHeader: shouldShowAllSection, surfacedCount }}
          inputRowRef={inputRowRef}
          inputRef={inputRef}
          recentIds={recentIds}
          frequentIds={frequentIds}
          remainingCandidates={remainingCandidates}
          selectorSuggestions={selectorSuggestions}
          candidatesById={candidatesById}
          filteredSuggestions={filteredSuggestions}
          highlightedClassId={highlightedClassId}
          highlightedSelectorId={highlightedSelectorId}
          createIntentKind={createIntent.kind}
          createValidationError={createValidationError}
          query={query}
          onClose={closeSuggestions}
          onPick={handleAddExisting}
          onPickSelector={handleSelectAmbient}
          onCreateAndAdd={handleCreateAndAdd}
          previewClass={previewClass}
          clearPreviewClass={clearPreviewClass}
        />
      </SelectorInputArea>
      {createError && <p role="alert" className={styles.errorText}>{createError}</p>}
      {unmatchedSelectorNotice && site?.styleRules[unmatchedSelectorNotice.ruleId] && (
        <UnmatchedSelectorNotice
          selector={unmatchedSelectorNotice.selector}
          onUndo={handleUndoUnmatchedSelector}
        />
      )}

      <SelectorPillStack
        pills={selectorModel.pills}
        showInlinePill={showInlinePill}
        inlineStyleEditing={inlineStyleEditing}
        onToggleRule={(ruleId, active) => setActiveClass(active ? null : ruleId)}
        onClassContextMenu={openClassContextMenu}
        onKeyboardClassContextMenu={openKeyboardClassContextMenu}
        onRemoveClass={removeAssignedClass}
        onToggleInline={() => setInlineStyleEditing(!inlineStyleEditing)}
        onClearInline={() => {
          clearNodeInlineStyles(nodeId)
          setInlineStyleEditing(false)
        }}
      />
    </div>
  )
}
