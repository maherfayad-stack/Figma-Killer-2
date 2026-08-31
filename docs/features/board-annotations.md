# Board annotations — sticky notes and doc cards

The non-code furniture on a Studio board: **sticky notes** (small, coloured,
text-only) and **doc cards** (larger, rich-text). They live in
`.studio/boards.json` alongside frames and guides, ride the same 800 ms
autosave, and never touch the user's React source — they annotate the board,
they are not part of the document.

> **Not the same thing as review comments**
> ([`studio-comments.md`](studio-comments.md)). Notes and doc cards are the
> designer's own scratch space — owned by a board, deleted when they stop being
> useful, and living in `boards.json` on the shared autosave. A comment is
> review: it is *about* a specific element, has an author who is not
> necessarily the reader, ends in `resolved` rather than deletion, lives in its
> own `.studio/comments.json`, and is readable by the agent.

Frames are the document; annotations are commentary on it. That distinction is
why they are separate layers, a separate selection list, and separate keyboard
handling, and why `bring to front` orders annotations against each other but
never against a frame.

---

## Shape

```ts
interface BoardStacked { z?: number }

interface StickyNote extends BoardStacked {
  id: string; x: number; y: number; w: number; h: number
  text: string; color: NoteColor
}

interface DocBlock extends BoardStacked {
  id: string; x: number; y: number; w: number; h: number
  html: string          // SANITIZED rich text
}
```

`z` is optional on both. Absent means "never reordered"; those items paint in
array order below anything that has been explicitly raised. After any
`bring to front` / `send to back` every annotation carries an absolute `z`, so
a later raise can never land in a tie it then loses to array order. Paint order
is applied as a real CSS `z-index` (`--annotation-z`), and **neither layer sets
a `z-index` of its own** — that is what lets a note and a doc interleave rather
than notes always sitting under docs.

### `DocBlock.html` replaced `DocBlock.markdown`

A card you format by typing cannot round-trip through markdown without either
losing what markdown has no syntax for (font family, size, colour, alignment)
or inventing a dialect for it. The field changed; it did not gain a sibling.

A pre-rich-text `boards.json` still carries `markdown`, and `serialize.ts`'s
`coerceDoc` renders it to HTML **on read** — once, at the boundary, so nothing
downstream ever sees two shapes. There is no `markdown` field on the type and
no code path that writes one.

That migration deliberately does **not** sanitize: `parseBoardsFile` also runs
on the server, where DOMPurify may not be installed and `sanitizeRichtext`
degrades to stripping every tag — which would silently destroy a user's card on
a read that never intended to write. Sanitization happens where a DOM is
guaranteed: on write (`updateDocHtml`) and on render (`DocBlockView`).

---

## Where the code lives

| Path | Owns |
|---|---|
| `@core/studio-board/types.ts` | `StickyNote`, `DocBlock`, `BoardStacked` |
| `@core/studio-board/boardsModel.ts` | Pure `Board -> Board` transforms: `resizeAnnotation`, `reorderAnnotations`, `annotationPaintOrder`, `MIN_ANNOTATION_SIZE` |
| `store/slices/boardAnnotationActions.ts` | Pure transforms with no store: add / move / duplicate / paste / nudge / remove |
| `store/slices/boardAnnotationSliceActions.ts` | The `set`/`get` wiring, the annotation SELECTION, the clipboard, and `clearAllSelections` |
| `canvas/useAnnotationInteraction.ts` | The pointer gesture both views share: select, drag-move with snapping, drag-resize |
| `canvas/rectResize.ts` | Pure eight-handle resize geometry, shared with board frames |
| `canvas/BoardNotesLayer/` | `StickyNoteView`, `useAutoFitText` |
| `canvas/BoardDocsLayer/` | `DocBlockView`, `DocToolbar`, `DocLinkDialog`, `docRichText` |
| `canvas/useBoardAnnotationKeyboard.ts` | Delete / Cmd+D / Cmd+C / Cmd+V / arrow-nudge |

---

## Selection

`selectedAnnotations: AnnotationRef[]` — `{ kind: 'note' | 'doc', id }`, because
a note and a doc share neither an id space nor a kind. It is a **third**
independent list beside `selectedNodeIds` and `selectedFrameIds`.

The two ways a selection is made want different behaviour, and the split is
explicit in `setSelection(refs, clearOthers)`:

- **Clicking** an annotation means "this one thing" — it clears the node and
  frame selections, so the Properties panel shows exactly one inspector.
- **Marqueeing** a region means "everything in here", and a region can
  legitimately contain both frames and notes. Clearing there would make one
  drag silently discard half of what it swept over, depending on which setter
  ran last.

Clicking empty canvas, or pressing Escape, clears **all three** lists through
the single `clearAllSelections` action. Clearing a subset leaves the board
looking deselected while a later Delete still has a target — that bug already
happened once, when the annotation list was added to one call site and
forgotten at the other.

---

## Gestures

**Click to select, click again to edit.** On an infinite canvas a single click
is how you pick something up, so making the first click also drop a text caret
makes an annotation impossible to select without risking an edit. Double-click
edits from any state. This is what Miro and Figma both do.

For a sticky note the whole body is the drag handle, so "click again" is
resolved on pointer**up**, and only if the pointer travelled less than
`DRAG_SLOP_PX` — otherwise the start of every drag would open the editor. A doc
card is dragged by its header only (its body is read-heavy and must support
text selection), so it has no such ambiguity and decides immediately.

**Resize** uses the same eight handles a board frame does, rendered only while
selected, clamped to `MIN_ANNOTATION_SIZE` in the pure transform rather than at
the drag site — so a programmatic caller cannot produce an ungrabbable card
either. Both cards set `overflow: visible`, because the handles sit just
outside the box.

**Right-click** opens a menu on either kind: edit, duplicate, colour (notes),
bring to front / send to back, delete.

**Keyboard** (`useBoardAnnotationKeyboard`): Delete/Backspace, Cmd+D duplicate,
Cmd+C / Cmd+V, arrows to nudge (Shift = 10×). A `document`-level listener scoped
by INTENT, not focus — for the reason `useCanvasSelectionKeyboard.ts` documents
at length: selecting anything tends to move DOM focus into a panel, where a
React `onKeyDown` on the canvas would never fire. It stands down for text
fields, contentEditables, open overlays, and already-claimed keystrokes.

Duplicate and paste **select what they created**, so a second Cmd+D walks
diagonally instead of stacking clones on one spot. Each successive paste of the
same clipboard steps further out; a fresh copy restarts the ladder.

The clipboard holds **values, not refs** — copy → delete → paste is an ordinary
sequence, and a ref would dangle. It also survives a board switch, which is when
pasting furniture is most useful.

---

## A sticky note is drawn as an object, not as a surface

The `--note-*` tokens in `globals.css` are the one place in the app that is
deliberately **not** derived from the accent scale and **not theme-reactive**.
A sticky note is a picture of a physical thing: an opaque pastel square with
dark ink, a tight contact shadow, no border, and centred text — in light mode
and dark mode alike, the way it is in Miro and on a real wall.

An earlier version derived the fills from `--accent-*` at 10% alpha. That
produced a translucent olive/navy wash of the canvas background: a tint *of*
the board rather than a note *on* it. Because the fill is now a fixed light
pastel in both themes, the text on it is a fixed dark ink (`--note-ink`) rather
than `--text` — a surface that does not follow the theme must not have a
foreground that does.

The per-note chrome (colour swatches + delete) floats in its own dark pill just
**above** the note's top edge, not inside it. Two bugs are why:

- in-flow at `opacity: 0` it still reserved ~20px at the top, so the text could
  never be vertically centred;
- ghost `Button`s drawn straight onto a light pastel fill use the app's
  dark-surface hover colours and washed out. The pill restores the surface
  those buttons are built for.

The pill carries its own tight shadow rather than `--shadow-panel-drop`, whose
blur radius is tuned for a panel floating over a dark app surface and, cast
down onto pale paper a few pixels below, reads as a smudge.

## Sticky note text auto-fits

A Miro sticky is a fixed rectangle whose text scales to fill it: you resize the
note, not the type. `useAutoFitText` binary-searches the font size (~5 forced
layouts instead of ~30 for a linear walk) in `useLayoutEffect`, so the fitted
size is committed before paint rather than visibly settling. A `ResizeObserver`
re-fits on drag-resize.

**The box and the content are two elements**, and must stay that way. The box
(`.textBox`) is the fixed, centred, clipping rectangle; the content (`.text`)
is what gets measured and sized. Measuring the content against *itself* only
works while the text is top-aligned — a vertically centred overflow escapes the
box in **both** directions, and `scrollHeight` sees neither, so a note would
settle at a size whose first and last lines were invisible. The
`ResizeObserver` watches the box for the same reason: the content's size is
this hook's own output, so observing it would feed the search back into itself.

The note commits `innerText`, not `textContent`. Pressing Enter in a
contentEditable inserts a `<div>` or `<br>`, and `textContent` concatenates
across them — a two-line note would be stored as one run-on line.

It is deliberately **not** applied to doc cards. A doc is a document: it has
typography the author chose, it scrolls when it overflows, and its font size
must not be silently overridden.

---

## The doc card's rich text

`docRichText.ts` is built on `document.execCommand`. That API is formally
deprecated and is still the right tool here, for two reasons worth not
"fixing":

1. It is the only built-in that edits a contentEditable subtree **through the
   browser's own undo stack**. A hand-rolled Range implementation of bold or
   list-toggling breaks Cmd+Z inside the card, which is worse than the
   deprecation.
2. Every evergreen browser implements it, and no replacement (`EditContext`) is
   shipped across them yet.

Pulling in ProseMirror/Lexical/TipTap would add a ~100 KB editor framework to
the admin bundle to format a canvas sticky's bigger sibling. Revisit only if
doc cards grow into real documents.

`styleWithCSS` is enabled for every command so the browser emits
`<span style>` rather than the legacy `<font>` element, which is not in the
sanitizer's allow-list and would be stripped on save — making formatting
silently vanish on reload.

### There is deliberately no font-family or font-size control

`execCommand`'s own `fontName`/`fontSize` are unusable here — `fontSize` accepts
only the legacy 1–7 scale, and both emit markup the sanitizer profile does not
allow. The replacement (wrap the selection in a styled span via `insertHTML`)
was built and then removed: it silently did nothing for the common cases — a
collapsed caret, a selection spanning more than one block — so the control
looked functional and was not.

Sizing is expressed through the **block format** instead (Body / Heading 1-3 /
Quote / Code), which is what a doc card actually needs, is one `execCommand`
away, and always applies. Removing the two dropdowns also took the toolbar from
sideways-scrolling to comfortably fitting. If per-word typography is ever
genuinely wanted it needs a real editor model, not another span-wrapping hack.

**A block is a heading OR a list, never both.** `execCommand` does not know
that — turning a list on inside an `<h1>` yields
`<h1><ol><li>…</li></ol></h1>`, invalid HTML that renders as a heading-sized
list item inside a heading and is then persisted. `withExclusiveBlock` /
`toggleList` turn the other one off first.

### The editor and the reader must never be the same DOM node

The doc card has three body states — editing, rendered, empty — and each one
renders under its **own React key**. The keys are load-bearing.

React reconciles by position and element type. Without distinct keys the
editor `<div>` and the reader `<div>` are the *same host instance*: React keeps
the DOM node and swaps its props. But that node's children are not React's —
the editor writes them with `el.innerHTML`, because `execCommand` mutates the
DOM directly and nothing else would ever observe the change. So on the way out
of a session React believed the node was empty, mounted the reader's markup and
**appended** it beside the text already there. The card then showed the
document twice: once unstyled (the leftover, which no longer carried
`.rendered`) and once styled.

That is one bug behind two symptoms — "text duplicates when I leave the card"
and "the styles don't apply" — and both are locked down by
`BoardDocsLayer/__tests__/docBlockEditingSession.test.tsx`.

**The general rule:** any element whose children are written imperatively must
never share a reconciliation slot with an element whose children are React's.
Give it a key, or give it its own branch.

### The toolbar must not re-render at typing speed

`selectionchange` fires on every keystroke, not only on a deliberate caret
move. The toolbar listens to it to keep its pressed states honest, and
`readActiveCommands` allocates a fresh `Set` each call — so a naive
`setActiveCommands(readActiveCommands())` re-rendered two `<Select>`s, a
`<ColorInput>` and eight tooltip-bearing `<Button>`s on every character typed.
That was a reported lag. The state setter now compares set *contents* and
returns the current value when they match, which makes typing a word cost zero
renders.

(The other half of that report was a `requestAnimationFrame` loop that measured
and repositioned the toolbar 60×/s for the whole session; it is gone — see the
positioning note in `DocToolbar.tsx`.)

### Three traps in the toolbar

Both were live bugs; neither is obvious from the code.

**Do not `preventDefault()` mousedown on the toolbar container.** `execCommand`
acts on the live selection and a control that takes focus collapses it, so
suppressing focus looks like the fix. It also stops every `<Select>` from
opening, because a custom listbox opens on the very mousedown being cancelled.
The correct fix is to *remember* the selection: `selectionchange` stores the
last Range that was inside this card's editable body, and every command
restores it before running. Plain buttons still suppress their own mousedown,
but only to avoid a focus round-trip — nothing depends on it.

**Never restore a remembered Range blindly.** A `Range` holds references to
live nodes, and `formatBlock` REPLACES the block element — so the range
remembered a moment ago can point at detached nodes, and restoring it applies
the next command somewhere meaningless. `run()` restores only when the live
selection is not already inside the editor AND the remembered range's nodes are
still attached (`editable.contains()` is false for a detached node), and
re-remembers the selection each command leaves behind.

**Do not end the editing session on `blur`.** The toolbar is portaled to
`document.body`, so focusing one of its Selects blurs the editor — which
committed and unmounted the toolbar mid-click. `DocBlockView` uses an
outside-**pointerdown** check instead, which can ask the question that actually
matters ("is what you just pressed part of this session?") by looking for
`[data-doc-toolbar]` and for portaled `[role="dialog"|"listbox"|"menu"]`.

**Do not position the toolbar from a `requestAnimationFrame` loop.** It was
written that way first, reasoning that a pan writes the canvas transform
imperatively to a ref and emits no event. It measured and wrote to the DOM 60
times a second for the whole editing session and was a reported source of lag.
The position now recomputes from the store's `zoom`/`panX`/`panY` plus a
`ResizeObserver` on the card — which fire only when the answer changes — and the
canvas cannot be pointer-panned mid-edit anyway, because a pointerdown on it
ends the session first. `overlayRafDiscipline.test.ts` gates this.

### Sanitization

`sanitizeBoardDocHtml` (`@core/sanitize`) is `RICHTEXT_CONFIG` plus `style` and
`align`. It is its own profile, **not** a relaxation of `RICHTEXT_CONFIG`:
that one is on the published path and must stay as tight as it is. A `DocBlock`
is board furniture — it renders only inside the admin canvas and is never
emitted by the publisher. DOMPurify runs allowed inline styles through its own
CSS parser, dropping `url()`, `expression()` and anything else executable.

Font stacks in `DOC_FONT_FAMILIES` are literal, never `var(--font-sans)`: a
custom-property reference is exactly the kind of value a CSS sanitizer may
drop, which would silently un-style text on the next save.
