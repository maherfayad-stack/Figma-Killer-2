/**
 * ImageSourceSection — Studio's image-source control (WS-8.3), rendered
 * instead of the generic schema-driven `src` row for a node whose module
 * declares `imageEdit` (`base.image` -> `'src'`), while Studio mode is
 * active, and only when there is something honest for it to do — the caller
 * (`renderModuleTabContent`) gates on exactly that before mounting this at
 * all, so a node this control can do nothing for keeps the existing
 * `CodeValueControl` fallback instead.
 *
 * Two cases:
 *
 *   1. **Import-bound, traced** (`PageNode.assetOrigin` present). This is the
 *      case that was locked before WS-8.3: `<img src={heroImg}/>` where
 *      `heroImg` is a local image import. Replacing the file here rewrites
 *      the IMPORT (`setImportSpecifier`, via `saveStudioAssetEdit`), never
 *      the JSX — the binding survives. Committed immediately on pick/drop,
 *      not queued into the ordinary autosave diff (see `saveStudioAssetEdit`'s
 *      doc comment for why).
 *   2. **Literal, writable** (`isPropWritableToSource` true, no `assetOrigin`).
 *      `src="/img/hero.png"` already had a writeback — `setJsxProp` — it just
 *      had the wrong (CMS media library) picker in front of it. Uploading
 *      here still lands the file on disk, but the new value is a plain string
 *      the user commits through the ordinary prop-change path (`onChange`),
 *      exactly like any other text control.
 */
import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { PageNode } from '@core/page-tree'
import { isPropWritableToSource } from '@core/page-tree'
import { FileUpload } from '@ui/components/FileUpload'
import { ControlRow } from '@ui/components/ControlRow'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { uploadStudioAsset } from '@site/studio/uploadStudioAsset'
import { saveStudioAssetEdit } from '@site/studio/studioSaveRequests'
import styles from './ImageSourceSection.module.css'

interface ImageSourceSectionProps {
  node: PageNode
  /** The module's declared image prop — `registry.get(moduleId)?.imageEdit?.prop`. */
  prop: string
  /** Resolved current value for this prop at the active breakpoint — a fetchable URL, when set. */
  value: unknown
  onChange: (propKey: string, value: unknown) => void
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.name)
}

export function ImageSourceSection({ node, prop, value, onChange }: ImageSourceSectionProps) {
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [localPreview, setLocalPreview] = useState<string | null>(null)
  const previewUrlRef = useRef<string | null>(null)

  const assetOrigin = node.assetOrigin
  const writable = isPropWritableToSource(node, prop)
  const currentUrl = localPreview ?? (typeof value === 'string' && value.length > 0 ? value : null)

  function releaseLocalPreview() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }

  // Revoke a still-live object URL on unmount (e.g. the user switches
  // selection while an upload is in flight). Reads only the ref, which
  // `exhaustive-deps` never requires in the array, so an empty array is
  // correct here — this must run once, on unmount, not on every render.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  async function handleFile(file: File) {
    if (!isImageFile(file)) {
      pushToast({ kind: 'error', title: 'Not an image', body: `"${file.name}" doesn't look like an image file.` })
      return
    }

    releaseLocalPreview()
    const objectUrl = URL.createObjectURL(file)
    previewUrlRef.current = objectUrl
    setLocalPreview(objectUrl)
    setUploading(true)

    try {
      // No explicit `targetDir` — the server defaults new uploads to
      // `src/assets`. (A future asset browser could offer the directory an
      // existing import already points at; out of scope for this slice.)
      const uploaded = await uploadStudioAsset(file)

      if (assetOrigin) {
        const originNodeId = `${assetOrigin.rel}:${assetOrigin.line}:${assetOrigin.col}`
        await saveStudioAssetEdit(originNodeId, uploaded.relPath)
        // The board reload triggered by `saveStudioAssetEdit` replaces this
        // node's props from freshly parsed source, which supersedes the
        // local object-URL preview — nothing further to do here.
      } else if (writable) {
        onChange(prop, `/${uploaded.relPath}`)
      }
    } catch (err) {
      releaseLocalPreview()
      setLocalPreview(null)
      pushToast({ kind: 'error', title: 'Image upload failed', body: getErrorMessage(err, 'Unknown upload error') })
    } finally {
      setUploading(false)
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragActive(false)
    const file = event.dataTransfer.files[0]
    if (file) void handleFile(file)
  }

  return (
    <ControlRow propKey={prop} label="Image" layout="stacked">
      <div
        className={styles.dropZone}
        data-active={dragActive ? 'true' : undefined}
        data-testid={`image-source-${prop}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <div className={styles.preview}>
          {currentUrl ? (
            <img src={currentUrl} alt="" className={styles.previewImg} />
          ) : (
            <ImageSolidIcon size={20} />
          )}
        </div>
        <div className={styles.actions}>
          <FileUpload
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml"
            buttonProps={{ variant: 'secondary', size: 'sm', disabled: uploading }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0]
              e.currentTarget.value = ''
              if (file) void handleFile(file)
            }}
          >
            <CloudUploadSolidIcon size={12} />
            {uploading ? 'Uploading…' : 'Replace image'}
          </FileUpload>
          <span className={styles.dropHint}>or drop a file</span>
        </div>
      </div>
      <span className={styles.hint}>
        {assetOrigin
          ? 'Replacing this image rewrites the import in your source — every place it is used updates.'
          : 'Writes a new src attribute directly.'}
      </span>
    </ControlRow>
  )
}
