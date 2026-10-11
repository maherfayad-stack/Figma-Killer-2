/**
 * GalleryAddVariantButton — the "+" in a variants-gallery frame's header
 * (CV-3): add a variant to the component the gallery shows. It renders on a
 * gallery frame only (`isGalleryRootNodeId`) and, for one, only once the
 * component catalog has said the component is a local one Studio can write.
 *
 * The component is read off the gallery page's own cells — every cell is an
 * instance of it — so the header needs no extra wire field. The form is the
 * Component section's `AddVariantPopover`; the write, its undo and its refusals
 * are the same ones.
 *
 * A press on the button must not start the header's frame move-drag nor its
 * double-click rename, hence the two stopped events.
 */
import { useRef, useState } from 'react'
import { isGalleryRootNodeId } from '@core/component-variants'
import type { Page } from '@core/page-tree'
import { AddVariantPopover } from '@site/inspector/sections/AddVariantPopover'
import { enumPropsOf } from '@site/inspector/sections/variantAxes'
import { findLocalComponentSpec, useLocalComponentCatalog } from '@site/studio/componentCatalog'
import { Button } from '@ui/components/Button'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import styles from './GalleryAddVariantButton.module.css'

interface GalleryInstanceProps {
  componentName?: string
  sourceFile?: string
}

export function GalleryAddVariantButton({ page }: { page: Page }) {
  if (!isGalleryRootNodeId(page.rootNodeId)) return null
  return <GalleryAddVariant page={page} />
}

function GalleryAddVariant({ page }: { page: Page }) {
  const catalog = useLocalComponentCatalog()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const instance = Object.values(page.nodes).find((node) => node.moduleId === 'studio.instance')
  const { componentName, sourceFile } = (instance?.props ?? {}) as GalleryInstanceProps
  const spec = catalog && componentName && sourceFile ? findLocalComponentSpec(catalog, componentName, sourceFile) : null
  if (!spec || spec.role !== 'component' || enumPropsOf(spec).length === 0) return null

  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="micro"
        iconOnly
        className={styles.add}
        aria-label={`Add a ${spec.name} variant`}
        aria-haspopup="dialog"
        aria-expanded={open}
        tooltip="Add variant"
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={() => setOpen((isOpen) => !isOpen)}
        data-testid="gallery-add-variant"
      >
        <PlusIcon size={12} aria-hidden="true" />
      </Button>
      {open && <AddVariantPopover id="gallery-add-variant" anchorRef={anchorRef} spec={spec} onClose={() => setOpen(false)} />}
    </>
  )
}
