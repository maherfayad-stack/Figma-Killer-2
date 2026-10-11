/** PA-6 — Frame selection's measured write: the frame's inline style and each member's patch (`null` removes a key). */
export interface FrameRequest {
  wrapperStyle: Record<string, string>
  memberStyles: Record<string, Record<string, string | number | null>>
}
