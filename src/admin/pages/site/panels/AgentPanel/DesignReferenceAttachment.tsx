import type { ChangeEvent, CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { FileUpload } from '@ui/components/FileUpload'
import { RulerDimensionSolidIcon } from 'pixel-art-icons/icons/ruler-dimension-solid'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { useDesignReferenceAttachment } from './useDesignReferenceAttachment'
import styles from './AgentPanel.module.css'

interface DesignReferenceAttachmentProps {
  disabled: boolean
}

/**
 * Attach ONE lossless design reference (a Figma export, typically) used to
 * measure fidelity against — distinct from the per-message chat images
 * `PendingImageAttachmentGrid` renders. The reference is never re-encoded
 * and is not cleared when a chat message sends.
 */
export function DesignReferenceAttachment({ disabled }: DesignReferenceAttachmentProps) {
  const {
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
  } = useDesignReferenceAttachment()

  function handleSelect(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0] ?? null
    // Let the same local file fire change again after it is removed.
    event.currentTarget.value = ''
    if (file) attach(file)
  }

  const attached = reference !== null || uploading
  const width = reference?.width ?? pendingDimensions?.width ?? null
  const height = reference?.height ?? pendingDimensions?.height ?? null
  const filename = pickedFilename ?? reference?.label ?? (previewUrl ? 'Design reference' : null)

  if (!attached) {
    return (
      <FileUpload
        accept="image/png,image/jpeg,image/webp"
        onChange={handleSelect}
        buttonProps={{
          variant: 'ghost',
          size: 'xs',
          disabled: disabled || loading,
          tooltip: 'Uploaded losslessly and matched pixel-for-pixel — never sent to the model',
          'aria-label': 'Attach design reference',
          className: styles.referenceAttachButton,
        }}
      >
        <RulerDimensionSolidIcon size={12} aria-hidden="true" />
        <span>Attach design reference</span>
      </FileUpload>
    )
  }

  return (
    <div className={styles.referenceChip} role="group" aria-label="Design reference">
      <div className={styles.referenceThumb} aria-hidden="true">
        {previewUrl
          ? <img src={previewUrl} alt="" className={styles.referenceThumbImage} />
          : <RulerDimensionSolidIcon size={16} />}
      </div>
      <div className={styles.referenceInfo}>
        <span className={styles.referenceFilename} title={filename ?? undefined}>
          {filename ?? 'Design reference'}
        </span>
        <span className={styles.referenceMeta}>
          {uploading
            ? width && height
              ? `${width} × ${height} · Uploading… ${Math.round(progress * 100)}%`
              : `Uploading… ${Math.round(progress * 100)}%`
            : reference
              ? `${reference.width} × ${reference.height} · ${formatBytes(reference.sizeBytes)}`
              : ''}
        </span>
        {uploading && (
          <div className={styles.referenceProgressTrack}>
            <div
              className={styles.referenceProgressFill}
              style={{ '--reference-progress': `${Math.round(progress * 100)}%` } as CSSProperties}
            />
          </div>
        )}
        {error && (
          <span role="alert" className={styles.referenceError}>{error}</span>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="micro"
        iconOnly
        disabled={disabled}
        onClick={remove}
        tooltip="Remove design reference"
        aria-label="Remove design reference"
        className={styles.referenceRemove}
      >
        <CloseIcon size={10} aria-hidden="true" />
      </Button>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
