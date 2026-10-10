/**
 * Where a cross-frame drop landed, and where it came from — the argument
 * `transplantNodes` takes.
 *
 * `originPageId` is named explicitly rather than derived from the active
 * document: a cross-frame drag ACTIVATES the destination frame on the way
 * (`openPageInCanvas` fires from `onPointerDownCapture`), so by the time the
 * drop commits, "the active page" is already the wrong end of the gesture.
 */
export interface TransplantDestination {
  /** The page the dragged element is written in. */
  originPageId: string
  /** The page the drop landed in — a DIFFERENT page. */
  pageId: string
  /** The container the drop resolved to, in `pageId`'s tree. */
  parentId: string
  /** Where among that container's canvas children the drop landed. */
  index: number
  /** Alt held: copy across frames instead of moving. */
  copy?: boolean
}
