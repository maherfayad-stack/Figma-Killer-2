/**
 * landImageSource — the ONE landing call every image gesture makes, whatever
 * the image arrived as (audit 07 §A.2). A dropped or picked file is uploaded
 * (`asset-drop`), a URL dragged out of another tab is fetched by the server
 * (`asset-drop-url`, IMG-5), and a file already in the project (the Assets
 * panel's Images section, IMG-6) is not landed at all — it is referenced.
 * Every one of them answers with the same `DroppedStudioAsset`, so the insert,
 * the replace, the background and the free canvas never branch on the intake.
 *
 * `imageSourcePreview` is the other half: what the optimistic ghost shows
 * before the landing answers.
 */
import type { ImageDropSource } from '@site/store/slices/site/imageDropShapes'
import { dropStudioAsset, dropStudioAssetUrl, type DroppedStudioAsset } from './dropStudioAsset'
import { invalidateProjectImageAssets, studioAssetPreviewUrl } from './projectAssets'

export interface LandImageSourceOptions {
  /** Upload progress, 0..1 — a file only; the other kinds send no bytes. */
  onProgress?: (fraction: number) => void
  /** The source file the element is written into — see `DropStudioAssetOptions.pageRel`. */
  pageRel?: string
}

/**
 * Where a project file is referenced from, decided by the file's OWN place
 * rather than by the project's convention: a file the production build serves
 * at `src` is written as that literal, and any other file can only be reached
 * through an import (`src={x}`). Nothing is uploaded or copied — dragging a
 * project image in twice must not leave two files behind.
 */
function referenceProjectFile(source: Extract<ImageDropSource, { kind: 'project' }>): DroppedStudioAsset {
  const fields = { relPath: source.relPath, width: source.width, height: source.height, deduped: true }
  return source.src !== null && source.buildSafe
    ? { ok: true, mode: 'public', src: source.src, ...fields }
    : { ok: true, mode: 'import', ...fields }
}

/** Land (or reference) one image. Throws `ApiError` with the server's sentence on a refusal. */
export async function landImageSource(
  source: ImageDropSource,
  options: LandImageSourceOptions = {},
): Promise<DroppedStudioAsset> {
  const pageRel = options.pageRel ? { pageRel: options.pageRel } : {}
  if (source.kind === 'project') return referenceProjectFile(source)
  const landed =
    source.kind === 'url'
      ? await dropStudioAssetUrl(source.url, pageRel)
      : await dropStudioAsset(source.file, { ...pageRel, ...(options.onProgress ? { onProgress: options.onProgress } : {}) })
  // A new file is in the project: the Assets panel's Images section (and the
  // Fill picker) list it from now on. A dedupe wrote nothing new.
  if (!landed.deduped) invalidateProjectImageAssets()
  return landed
}

export interface ImageSourcePreview {
  /** What the ghost's `src` is while the landing is in flight. */
  url: string
  /** Frees whatever the preview holds (an object URL); safe to call once the ghost is gone. */
  release: () => void
}

/**
 * The ghost's picture. A file's own bytes through an object URL (revoked on
 * release). A project file through the authenticated admin preview route —
 * the same thumbnail the panel showed. A dragged URL shows itself: the tab it
 * came from was already displaying that exact image.
 */
export function imageSourcePreview(source: ImageDropSource): ImageSourcePreview {
  if (source.kind === 'file') {
    const url = URL.createObjectURL(source.file)
    return { url, release: () => URL.revokeObjectURL(url) }
  }
  const url = source.kind === 'project' ? studioAssetPreviewUrl(source.relPath) : source.url
  return { url, release: () => {} }
}
