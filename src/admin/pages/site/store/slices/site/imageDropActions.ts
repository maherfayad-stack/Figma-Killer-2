/**
 * imageDropActions — what image files dropped from the operating system onto a
 * board frame do to the user's source (D2 G15, widened by P5-B).
 *
 * Three actions, one per meaning `canvasFileDrop.ts` resolves:
 *
 *   - `dropImagesIntoPage` — INSERT. Every file lands (in parallel, through
 *     `asset-drop`), then ONE `insert` edit writes them all as a run of
 *     sibling `<img>`s (IMG-2): one write, one resync, one undo step whose
 *     inverse deletes every one of them.
 *   - `replaceImageInPage` — REPLACE the source of the `<img>` the files were
 *     dropped on (IMG-3).
 *   - `setBackgroundImageInPage` — ⇧-drop: the container's BACKGROUND image
 *     (IMG-7).
 *
 * ## Why they name the page instead of using the active one
 *
 * A dropped file lands wherever the pointer happens to be, which can be any
 * frame on the board, and the frame under a drop has never been activated by
 * a pointerdown because there was no pointerdown. So each action names its
 * page — and then ACTIVATES it (`openPageInCanvas`), the audit's decision
 * (07 §A.7): a drop is a user gesture on that frame, the optimistic ghost and
 * the value writes below both address the active tree, and the drop selects
 * its result the way Figma does.
 *
 * ## The ghost (IMG-8)
 *
 * Before this, nothing showed until upload + write + re-parse had all
 * finished — seconds of dead canvas for a large photo. Now the drop paints an
 * optimistic `<img>` per file from its object URL at once (perf-10's preview
 * machinery, `previewOptimisticInsertRun`), marked `data-studio-uploading`;
 * `EditorChromeInjector` dims it and the upload's progress fills it. The
 * write's own resync replaces the page and erases the ghost; a drop whose
 * every file was refused rolls it back. Object URLs are revoked either way.
 *
 * ## The structural queue is held across the upload
 *
 * `beginStructuralCommit()` is taken BEFORE the upload starts and released by
 * the commit's own `endStructuralCommit()` (or here, when nothing is
 * committed). The upload can take seconds, and a structural write landing
 * inside that window would resync the page out from under the ghost and
 * renumber the ids the insert was planned against. Holding the queue makes
 * every other structural gesture wait its turn — queued, not refused — exactly
 * as it would behind any write on the wire.
 */
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { canWriteInlineStyleForModule, isSourceDerivedNodeId, styleValueKey, type NodeTree, type PageNode } from '@core/page-tree'
import { clampImageSize, absolutePlacementStyle, type AbsoluteImagePlacement } from '@site/canvas/canvasImageDropPlacement'
import { findRenderedCanvasElements } from '@site/canvas/canvasNodeLookup'
import { backgroundModelPatch, insertBackgroundLayer, parseBackgroundLayers } from '@site/panels/PropertiesPanel/backgroundLayers'
import { wrapUrlPayload } from '@site/panels/PropertiesPanel/gradientValue'
import { dropStudioAsset, type DroppedStudioAsset } from '@site/studio/dropStudioAsset'
import { studioAssetRelFromPreviewUrl } from '@site/studio/projectAssets'
import { beginStructuralCommit, deferWhileStructuralCommitInFlight, endStructuralCommit } from '@site/studio/structuralCommitQueue'
import { commitStudioAssetReplace, commitStudioInsert } from '@site/studio/studioStructuralCommits'
import { uploadStudioAsset } from '@site/studio/uploadStudioAsset'
import type { InsertPropValue } from '@site/studio/studioSaveRequests'
import { previewOptimisticInsertRun, type OptimisticPreviewHandle } from './structuralOptimism'
import { STRUCTURAL_REFUSAL_TITLE, planSourceInsert, presentStructuralRefusal, type SourceInsertCommit } from './structuralSourceEdits'
import type { SiteSlice, SiteSliceHelpers } from './types'

type ImageDropActions = Pick<SiteSlice, 'dropImagesIntoPage' | 'replaceImageInPage' | 'setBackgroundImageInPage'>

/** Everything an image INSERT drop carries from the canvas to the store. */
export interface ImageDropRequest {
  pageId: string
  /** The container and index the drop line showed. */
  parentId: string
  index: number
  /** The images, in drop order. */
  files: readonly File[]
  /** The container's content-box width (CSS px) the intrinsic size is clamped to; `null` = do not clamp. */
  maxWidth: number | null
  /** ⌘-drop: the absolute placement in the container's space; `null` for a flow drop. */
  absolute: AbsoluteImagePlacement | null
}

/** Title every refusal and failure of the image gestures shares. */
export const IMAGE_DROP_TITLE = 'Cannot add that image'

/** The attribute the ghost carries while its bytes upload — `EditorChromeInjector`'s selector. */
export const UPLOADING_ATTRIBUTE = 'data-studio-uploading'
/** The custom property the upload's progress (0..1) is written into. */
export const UPLOAD_PROGRESS_PROPERTY = '--studio-upload-progress'

/**
 * The `alt` a dropped image starts with: its own file name without the
 * extension. A placeholder the inspector fixes — but an `<img>` with NO `alt`
 * is a real accessibility defect written into someone's repository, and an
 * empty one asserts the image is decorative, which Studio cannot know.
 */
export function altTextFor(file: File): string {
  const base = file.name.replace(/\.[^./\\]+$/, '').trim()
  return base.length > 0 ? base : 'Image'
}

/**
 * Paint an upload's progress onto every rendered element of `nodeId` — the
 * ghost, or the `<img>` being replaced. A pure WRITE (no measurement), once
 * per XHR progress event; React owns neither the attribute nor the property,
 * so a re-render leaves them alone.
 */
function paintUploadProgress(nodeId: string, fraction: number | null): void {
  for (const { element } of findRenderedCanvasElements(nodeId)) {
    if (fraction === null) {
      element.removeAttribute(UPLOADING_ATTRIBUTE)
      element.style.removeProperty(UPLOAD_PROGRESS_PROPERTY)
    } else {
      element.setAttribute(UPLOADING_ATTRIBUTE, '')
      element.style.setProperty(UPLOAD_PROGRESS_PROPERTY, String(Math.max(0, Math.min(1, fraction))))
    }
  }
}

/**
 * One toast for every file a gesture could not land, however many.
 *
 * An error only when NOTHING landed — the gesture failed as a whole, in the
 * server's own words. When the rest were written, the canvas already shows
 * the result, so the files left behind are a warning naming them.
 */
function reportUnlanded(failures: readonly { name: string; message: string }[], landedCount: number): void {
  const [first] = failures
  if (!first) return
  const names = failures.map((failure) => `"${failure.name}"`).join(', ')
  const body = failures.length === 1 ? `${names}: ${first.message}` : `${names} — ${first.message}`
  if (landedCount > 0) {
    pushToast({
      kind: 'warning',
      title: `${failures.length} image${failures.length === 1 ? '' : 's'} not added`,
      body,
      location: 'site-editor',
    })
    return
  }
  pushToast({ kind: 'error', title: IMAGE_DROP_TITLE, body, location: 'site-editor' })
}

function findPage(get: SiteSliceHelpers['get'], pageId: string): NodeTree<PageNode> | null {
  // A plain scan, not `store.ts`'s memoised `lookupCanvasPageById`: this
  // module is imported BY the composed store, so importing that memo back
  // would close a cycle. One O(pages) walk per DROP.
  return get().site?.pages.find((page) => page.id === pageId) ?? null
}

function activatePage(get: SiteSliceHelpers['get'], pageId: string): void {
  if (get().activePageId !== pageId || get().activeDocument !== null) get().openPageInCanvas(pageId)
}

/** Take a preview back only if its ghosts are still on the board — a resync that already replaced the page took them with it. */
function rollbackGhosts(get: SiteSliceHelpers['get'], pageId: string, optimistic: OptimisticPreviewHandle | null): void {
  if (!optimistic) return
  const page = findPage(get, pageId)
  if (page && optimistic.nodeIds.every((id) => page.nodes[id])) optimistic.rollback()
  else optimistic.settle([])
}

export function createImageDropActions(helpers: SiteSliceHelpers): ImageDropActions {
  const { get, set } = helpers

  const actions: ImageDropActions = {
    dropImagesIntoPage: (drop) => {
      // A drop fired while another structural write is on the wire runs next,
      // re-planned against the tree that write's resync leaves behind
      // (`structuralCommitQueue.ts`).
      if (
        deferWhileStructuralCommitInFlight((relocate) => {
          actions.dropImagesIntoPage({ ...drop, parentId: relocate(drop.parentId) })
        }, [drop.parentId])
      ) {
        return
      }
      if (drop.files.length === 0) return

      const tree = findPage(get, drop.pageId)
      if (!tree) return
      activatePage(get, drop.pageId)

      const plan = planSourceInsert(tree, drop.parentId, drop.index)
      if (!plan.ok) {
        presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
          nodeId: plan.nodeId,
          retry: (newParentId) => actions.dropImagesIntoPage({ ...drop, parentId: newParentId }),
          getState: get,
          set,
        })
        return
      }
      // A `null` commit means this page is an ordinary CMS tree, which has no
      // file for an `<img>` literal to point at — the drop has nowhere honest
      // to land, and minting a canvas-only node the next parse would delete
      // is not an answer either.
      const commit = plan.commit
      if (!commit) return

      // Held until the commit below releases it — see this module's doc.
      beginStructuralCommit()
      void landAndInsert(helpers, drop, commit)
    },

    replaceImageInPage: (pageId, nodeId, file) => {
      const tree = findPage(get, pageId)
      const node = tree?.nodes[nodeId]
      if (!tree || !node) return
      activatePage(get, pageId)

      void (async () => {
        const onProgress = (fraction: number) => paintUploadProgress(nodeId, fraction)
        try {
          if (node.assetOrigin) {
            // Import-bound (`src={hero}`): the IMPORT is repointed, never the
            // JSX. The new file lands beside the one the import names now, so
            // the project's own asset folder stays where it was.
            const previous = typeof node.props.src === 'string' ? studioAssetRelFromPreviewUrl(node.props.src) : null
            if (!previous) {
              reportUnlanded([{ name: file.name, message: 'Studio could not tell which file this image imports, so it left the import alone.' }], 0)
              return
            }
            const targetDir = previous.includes('/') ? previous.slice(0, previous.lastIndexOf('/')) : undefined
            const uploaded = await uploadStudioAsset(file, { ...(targetDir ? { targetDir } : {}), onProgress })
            const origin = node.assetOrigin
            await commitStudioAssetReplace(`${origin.rel}:${origin.line}:${origin.col}`, uploaded.relPath, previous)
            return
          }
          // A literal `src="/old.png"`: the new file lands in `public/` and
          // its served URL replaces the literal through the ordinary value
          // path — one history entry, one autosaved `prop` write.
          const landed = await dropStudioAsset(file, { onProgress })
          get().updateNodeProps(nodeId, { src: landed.src })
        } catch (err) {
          console.error('[image-drop] replacing an image failed:', err)
          reportUnlanded([{ name: file.name, message: getErrorMessage(err, 'The image could not be saved to your project.') }], 0)
        } finally {
          paintUploadProgress(nodeId, null)
        }
      })()
    },

    setBackgroundImageInPage: (pageId, nodeId, file) => {
      const tree = findPage(get, pageId)
      const node = tree?.nodes[nodeId]
      if (!tree || !node) return
      const refusal = refuseBackgroundTarget(node, get().site?.styleRules ?? {})
      if (refusal) {
        pushToast({ kind: 'warning', title: 'Cannot set that background', body: refusal, location: 'site-editor' })
        return
      }
      activatePage(get, pageId)

      void (async () => {
        try {
          const landed = await dropStudioAsset(file)
          // The same layer model the Fill section writes through: the new
          // image becomes the TOP background layer, every existing layer
          // (a gradient, another image) stays below it.
          const current = findPage(get, pageId)?.nodes[nodeId]
          if (!current) return
          const model = parseBackgroundLayers(current.inlineStyles ?? {})
          const before = backgroundModelPatch(model)
          const after = backgroundModelPatch(insertBackgroundLayer(model, 0, wrapUrlPayload(landed.src)))
          const patch: Record<string, string | number | null | undefined> = {}
          for (const [property, value] of Object.entries(after)) {
            if (before[property as keyof typeof before] !== value) patch[property] = value
          }
          if (Object.keys(patch).length > 0) get().setNodeInlineStyles(nodeId, patch)
        } catch (err) {
          console.error('[image-drop] setting a background image failed:', err)
          reportUnlanded([{ name: file.name, message: getErrorMessage(err, 'The image could not be saved to your project.') }], 0)
        }
      })()
    },
  }

  return actions
}

/**
 * The half of an insert drop that happens AFTER the structural queue was
 * reserved: paint the ghosts (synchronously — before the first await, so they
 * share the drop's frame), land every file, then ONE commit. Every path that
 * does not reach the commit releases the queue itself; the commit releases it
 * on its own once its resync has finished.
 */
async function landAndInsert(
  helpers: SiteSliceHelpers,
  drop: ImageDropRequest,
  commit: SourceInsertCommit,
): Promise<void> {
  const previewUrls: string[] = []
  let optimistic: OptimisticPreviewHandle | null = null
  let committing = false
  try {
    for (const file of drop.files) previewUrls.push(URL.createObjectURL(file))
    const ghostIds = drop.files.map(() => `optimistic:${crypto.randomUUID()}`)
    optimistic = previewOptimisticInsertRun(
      helpers,
      commit.parentNodeId,
      drop.index,
      drop.files.map((file, i) => ({
        moduleId: 'base.image',
        ghostId: ghostIds[i]!,
        props: { src: previewUrls[i]!, alt: altTextFor(file), htmlAttributes: { [UPLOADING_ATTRIBUTE]: '' } },
        // A ghost never overflows its frame while the real size is unknown;
        // a ⌘-drop ghost already sits where the image will.
        inlineStyles: {
          maxWidth: '100%',
          ...(drop.absolute ? absolutePlacementStyle(drop.absolute, i) : {}),
        },
      })),
    )

    const settled = await Promise.allSettled(
      drop.files.map((file, i) =>
        dropStudioAsset(file, { onProgress: (fraction) => paintUploadProgress(ghostIds[i]!, fraction) }),
      ),
    )
    const landed: { file: File; asset: DroppedStudioAsset; order: number }[] = []
    const failures: { name: string; message: string }[] = []
    settled.forEach((result, i) => {
      const file = drop.files[i]!
      if (result.status === 'fulfilled') landed.push({ file, asset: result.value, order: i })
      else {
        console.error('[image-drop] landing a dropped image failed:', result.reason)
        failures.push({ name: file.name, message: getErrorMessage(result.reason, 'The image could not be saved to your project.') })
      }
    })

    if (landed.length === 0) {
      rollbackGhosts(helpers.get, drop.pageId, optimistic)
      reportUnlanded(failures, 0)
      return
    }

    const elements = landed.map(({ file, asset, order }) => insertedImageProps(file, asset, drop, order))
    const [first, ...rest] = elements
    committing = true
    await commitStudioInsert({
      ...commit,
      name: 'img',
      props: first!,
      ...(rest.length > 0 ? { siblings: rest.map((props) => ({ name: 'img', props })) } : {}),
      undoLabel: elements.length > 1 ? `Add ${elements.length} images` : 'Add image',
      ...(optimistic ? { optimistic } : {}),
    })
    reportUnlanded(failures, landed.length)
  } catch (err) {
    console.error('[image-drop] the image drop failed:', err)
    if (!committing) rollbackGhosts(helpers.get, drop.pageId, optimistic)
  } finally {
    for (const url of previewUrls) URL.revokeObjectURL(url)
    if (!committing) endStructuralCommit()
  }
}

/**
 * The props one landed image is written with: the server's `src`, the file's
 * own name as `alt`, the intrinsic size clamped to the container (IMG-9), and
 * — for a ⌘-drop — K6's absolute placement, cascaded per image.
 */
function insertedImageProps(
  file: File,
  asset: DroppedStudioAsset,
  drop: ImageDropRequest,
  order: number,
): Record<string, InsertPropValue> {
  const size = clampImageSize(asset, drop.maxWidth)
  return {
    src: asset.src,
    alt: altTextFor(file),
    ...(size ? { width: size.width, height: size.height } : {}),
    ...(drop.absolute ? { style: absolutePlacementStyle(drop.absolute, order) } : {}),
  }
}

/**
 * Why a ⇧-drop may NOT write a background onto this element, or `null`.
 *
 * The drop writes the element's own INLINE style (`style={{…}}`), which is one
 * honest target only when nothing else already decides its background: a
 * class that declares one would still be the thing the Fill section edits,
 * and writing inline over it would quietly change which source wins. So a
 * class-owned background refuses with the remedy — the Fill section, which
 * asks where to write — rather than guessing.
 */
export function refuseBackgroundTarget(node: PageNode, styleRules: Record<string, { styles?: Record<string, unknown> }>): string | null {
  if (!isSourceDerivedNodeId(node.id)) return 'This element exists only on the canvas, so there is no source to write its background into.'
  if (!canWriteInlineStyleForModule(node.moduleId)) {
    return "This element's styles are written by its own component, so Studio cannot give it a background here."
  }
  const locked = node.codeProps ?? []
  if (locked.includes(styleValueKey('backgroundImage')) || locked.includes(styleValueKey('background'))) {
    return "This element's background is computed in code, so Studio cannot replace it. Change the expression in your editor."
  }
  const classOwned = node.classIds.some((id) => {
    const styles = styleRules[id]?.styles ?? {}
    return 'backgroundImage' in styles || 'background' in styles
  })
  if (classOwned) {
    return "This element's background comes from one of its classes. Select it and add the image in the Fill section, which asks whether to change the class or just this element."
  }
  return null
}
