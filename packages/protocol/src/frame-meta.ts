import { z } from 'zod';
import { NodeUidSchema } from './uid.js';

/**
 * FrameMeta — the `.studio/canvas.json` schema (playbook §0, §4/P0):
 *   { frames: [{framePath, x, y, w, h}], comments: [], zoomBookmarks: [] }
 *
 * This is the ONLY editor-owned persistent data (playbook §0 corollary /
 * §5 Global Risk #1: "no second scene model — ever"). It never affects app
 * runtime; it is spatial metadata only.
 *
 * `comments` and `zoomBookmarks` item shapes are NOT specified anywhere in
 * the playbook beyond "arrays, currently empty" — authored fresh here as a
 * forward-compatible best guess for P7 (Comments) and the canvas zoom-
 * bookmark feature. CHANGE-REQUEST: the `platform`/`chrome` owner (P5/P7)
 * should confirm or revise these two shapes before building on them; nothing
 * in P0-P4 reads or writes non-empty `comments`/`zoomBookmarks` arrays.
 */

export const FrameEntrySchema = z
  .object({
    /** Relative path from the file-folder root, e.g. "src/frames/Hero.tsx". */
    framePath: z.string().min(1),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  })
  .strict();

export const CommentSchema = z
  .object({
    id: z.string(),
    frameName: z.string(),
    /** Anchor to a specific JSX node when available (playbook §7). */
    nodeUid: NodeUidSchema.optional(),
    /** Frame-relative fallback position — used when nodeUid can't resolve
     * (code changed) so the comment degrades to "detached" instead of lost
     * (playbook §7 pitfall). */
    x: z.number(),
    y: z.number(),
    text: z.string(),
    resolved: z.boolean().default(false),
    createdAt: z.string(),
  })
  .strict();

export const ZoomBookmarkSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    x: z.number(),
    y: z.number(),
    zoom: z.number().positive(),
  })
  .strict();

export const FrameMetaSchema = z
  .object({
    frames: z.array(FrameEntrySchema),
    comments: z.array(CommentSchema),
    zoomBookmarks: z.array(ZoomBookmarkSchema),
  })
  .strict();

export type FrameEntry = z.infer<typeof FrameEntrySchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type ZoomBookmark = z.infer<typeof ZoomBookmarkSchema>;
export type FrameMeta = z.infer<typeof FrameMetaSchema>;
