/**
 * GalleryAddVariantButton — the "+" in a variants-gallery frame's header
 * (CV-3): add a variant to the component the gallery shows. It renders on a
 * gallery frame only (`isGalleryPage`) and, for one, only once the
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
import { isGalleryPage } from '@core/component-variants'
import type { Page } from '@core/page-tree'
import { LazyAddVariantPopover } from '@site/inspector/sections/LazyAddVariantPopover'
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
  if (!isGalleryPage(page)) return null
  return <GalleryAddVariant page={page} />
}

function GalleryAddVariant({ page }: { page: Page }) {
  const catalog = useLocalComponentCatalog()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  /**
   * Opens on the PRESS, not the click: pressing anywhere in a frame that is not
   * the active one activates it (`BoardFrameView`'s capture handler), and the
   * board can move the frame under the pointer before the button is released,
   * which loses the click. A first press on a frame must still do what it says.
   */
  const toggle = () => setOpen((isOpen) => !isOpen)

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
        onPointerDown={(event) => {
          if (event.button === 0) toggle()
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          // A pointer press already toggled on pointerdown; this is the keyboard's Enter/Space (`detail` 0).
          if (event.detail === 0) toggle()
        }}
        data-testid="gallery-add-variant"
      >
        <PlusIcon size={12} aria-hidden="true" />
      </Button>
      {open && <LazyAddVariantPopover id="gallery-add-variant" anchorRef={anchorRef} spec={spec} onClose={() => setOpen(false)} />}
    </>
  )
}
