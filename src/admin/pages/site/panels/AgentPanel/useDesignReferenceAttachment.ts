import { useEffect, useRef, useState } from 'react'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import {
  validateDesignReferenceDimensions,
  validateDesignReferenceFile,
  type DesignReferenceMeta,
  type ImageDimensions,
} from '@core/ai'
import {
  deleteDesignReference,
  fetchDesignReference,
  uploadDesignReference,
} from '../../studio/uploadDesignReference'
import { readDesignReferenceDimensions } from './designReferenceHeader'

export interface UseDesignReferenceAttachmentResult {
  /** The server-confirmed reference, once uploaded (or restored on mount). */
  reference: DesignReferenceMeta | null
  /** Best-effort dimensions read from the file locally, shown while an upload is in flight. */
  pendingDimensions: ImageDimensions | null
  /**
   * The picked file's own name, kept CLIENT-SIDE only — the wire schema has
   * no `filename` field (it mirrors the server's `DesignReference`, which
   * derives its on-disk name from `id`, never a caller-supplied string).
   * Uploaded as `label` so the server-recorded name matches once the route
   * lands, but this local copy is what the current session actually
   * displays; a reference restored via `fetchDesignReference` on a fresh
   * mount falls back to `reference.label`.
   */
  pickedFilename: string | null
  /** Local object URL for the just-attached file — never the re-fetched original (no read endpoint is assumed to exist). */
  previewUrl: string | null
  /** Restoring a previously attached reference on mount. */
  loading: boolean
  uploading: boolean
  /** 0-1 while `uploading`. */
  progress: number
  error: string | null
  attach: (file: File) => void
  remove: () => void
}

/**
 * One design reference per project — attach, watch it upload losslessly,
 * see its filename/dimensions/size, remove it. This is deliberately NOT the
 * same state machine as `usePendingImageAttachments`: a design reference is
 * a persistent project artifact for pixel-diffing, not per-message chat
 * content, so it is never cleared when a message sends.
 */
export function useDesignReferenceAttachment(): UseDesignReferenceAttachmentResult {
  const [reference, setReference] = useState<DesignReferenceMeta | null>(null)
  const [pendingDimensions, setPendingDimensions] = useState<ImageDimensions | null>(null)
  const [pickedFilename, setPickedFilename] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const controllerRef = useRef<AbortController | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const controller = new AbortController()
    fetchDesignReference(controller.signal)
      .then((existing) => {
        if (mountedRef.current) setReference(existing)
      })
      .catch(() => {
        // Treated as "no reference attached" — including a 404 while the
        // server-side reference store hasn't shipped yet.
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
    return () => {
      mountedRef.current = false
      controller.abort()
      controllerRef.current?.abort()
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  function setPreview(url: string | null): void {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = url
    setPreviewUrl(url)
  }

  function attach(file: File): void {
    const validationError = validateDesignReferenceFile(file)
    if (validationError) {
      pushToast({ kind: 'error', title: 'Could not attach design reference', body: validationError })
      return
    }

    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    setError(null)
    setPendingDimensions(null)
    setPickedFilename(file.name || null)
    setPreview(URL.createObjectURL(file))

    void (async () => {
      try {
        const dimensions = await readDesignReferenceDimensions(file)
        if (controller.signal.aborted) return
        const dimensionError = validateDesignReferenceDimensions(dimensions.width, dimensions.height)
        if (dimensionError) {
          setPreview(null)
          pushToast({ kind: 'error', title: 'Could not attach design reference', body: dimensionError })
          return
        }
        if (mountedRef.current) setPendingDimensions(dimensions)
      } catch {
        // Sniffing is best-effort — an unusual header layout just means the
        // UI shows no dimensions until the server's own measurement lands.
      }
      if (controller.signal.aborted) return

      setUploading(true)
      setProgress(0)
      try {
        const uploaded = await uploadDesignReference(file, {
          onProgress: (fraction) => {
            if (mountedRef.current) setProgress(fraction)
          },
          signal: controller.signal,
        })
        if (mountedRef.current) setReference(uploaded)
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current) return
        const message = getErrorMessage(err, 'The design reference could not be uploaded.')
        setError(message)
        setPreview(null)
        pushToast({ kind: 'error', title: "Couldn't attach design reference", body: message })
      } finally {
        if (mountedRef.current) setUploading(false)
      }
    })()
  }

  function remove(): void {
    controllerRef.current?.abort()
    const current = reference
    setReference(null)
    setPendingDimensions(null)
    setPickedFilename(null)
    setPreview(null)
    setError(null)
    setUploading(false)
    if (!current) return
    deleteDesignReference(current.id).catch((err) => {
      pushToast({
        kind: 'error',
        title: "Couldn't delete the design reference file",
        body: getErrorMessage(err, 'The file may still exist in the project.'),
      })
    })
  }

  return {
    reference,
    pendingDimensions,
    pickedFilename,
    previewUrl,
    loading,
    uploading,
    progress,
    error,
    attach,
    remove,
  }
}
