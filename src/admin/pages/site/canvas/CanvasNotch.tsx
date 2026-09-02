import { useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { registry } from "@core/module-engine";
import type { VisualComponent } from "@core/visualComponents";
import type { SavedLayout } from "@core/layouts";
import { useInsertModule } from "@site/hooks/useInsertModule";
import {
  DEFAULT_MODULE_INSERTER_FAVORITES,
  buildModuleInserterItems,
  recentKey,
  recentRefForItem,
  resolveInserterRefs,
  type ModuleInserterItem,
} from "@site/module-picker/moduleInserterModel";
import { useModuleInserterPreference } from "@site/module-picker/useModuleInserterPreference";
import { useModuleInsertionContext } from "@site/module-picker/useModuleInsertionContext";
import { resolveInsertLocation } from "@site/store/insertLocation";
import { CUSTOM_HTML_TAG_VALUE } from "@modules/base/utils/htmlTag";
import { selectActiveCanvasPage, useEditorStore } from "@site/store/store";
import { ModulePickerDropdown } from "@site/toolbar/ModulePickerDropdown";
import { ModuleIcon } from "@site/ui/ModuleIcon";
import type { IconComponent } from "pixel-art-icons/types";
import { BracesIcon } from "pixel-art-icons/icons/braces";
import { LayoutSolidIcon } from "pixel-art-icons/icons/layout-solid";
import { ArrowLeftIcon } from "pixel-art-icons/icons/arrow-left";
import { ArrowRightIcon } from "pixel-art-icons/icons/arrow-right";
import { CloseIcon } from "pixel-art-icons/icons/close";
import {
  FrameGlyphIcon,
  SectionGlyphIcon,
  TextGlyphIcon,
} from "@ui/components/ElementIcons";
import { Button } from "@ui/components/Button";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@ui/components/ContextMenu";
import { UndoRedoButtons } from "./UndoRedoButtons";
import { useCanvasInsertionDrag } from "./useCanvasInsertionDrag";
import { CanvasInsertionDragOverlay } from "./CanvasInsertionDragOverlay";
import { cn } from "@ui/cn";
import styles from "./CanvasNotch.module.css";

const ADD_TRIGGER_TEST_ID = "canvas-notch-add-btn";
const EMPTY_COMPONENTS: VisualComponent[] = [];
const EMPTY_SAVED_LAYOUTS: SavedLayout[] = [];

/**
 * Notch action — supplies either a `moduleId` (icon resolved through the
 * module registry via `ModuleIcon`) or a literal `icon` component. Module
 * actions should always pass `moduleId` so the icon stays in sync with the
 * module declaration; ad-hoc actions (e.g. content-document blocks) supply
 * `icon` directly.
 */
export type CanvasNotchAction = {
  id: string;
  label: string;
  onClick: () => void;
  /** Renders the action disabled, with this string as the tooltip. */
  disabledReason?: string;
} & (
  | { moduleId: string; icon?: never }
  | { icon: IconComponent; moduleId?: never }
);

interface CanvasNotchProps {
  actions?: CanvasNotchAction[];
  /**
   * Replaces the default Site-editor module picker. Leave undefined to show
   * it; pass null when reusing the notch for a non-site canvas.
   */
  addControl?: ReactNode;
  floatingControl?: ReactNode;
  /**
   * Show the Undo/Redo group on the left side of the notch.
   * Defaults to true. Disable for canvases that don't drive the editor
   * page tree (e.g. the content document canvas, which has its own
   * draft-management lifecycle).
   */
  showHistoryControls?: boolean;
  /**
   * Auto-hide the notch until hovered/focused, rolling it down from the top
   * edge on demand. Used in live mode, where the frame sits flush against the
   * top of the surface and a permanently-pinned notch would overlay the
   * page's own header. A slim handle stays visible as the hover affordance.
   * Defaults to false (the notch is always pinned, as in design mode).
   */
  peek?: boolean;
}

export function CanvasNotch({
  actions,
  addControl,
  floatingControl,
  showHistoryControls = true,
  peek = false,
}: CanvasNotchProps = {}) {
  return (
    <div
      className={cn(styles.shell, peek && styles.shellPeek)}
      aria-label="Insert modules"
      data-testid="canvas-notch"
      onClick={stopCanvasInteraction}
    >
      {peek && <div aria-hidden="true" className={styles.peekHandle} />}
      <div className={styles.roller}>
        <div className={styles.notch}>
          {showHistoryControls && (
            <>
              <UndoRedoButtons />
              <div aria-hidden="true" className={styles.divider} />
            </>
          )}

          {actions ? (
            actions.map((action) => renderActionButton(action))
          ) : (
            <>
              <PrimitiveNotchActions />
              <div aria-hidden="true" className={styles.divider} />
              <FavoriteNotchActions />
            </>
          )}

          {addControl === undefined ? (
            <ModulePickerDropdown
              triggerClassName={styles.addButton}
              triggerTestId={ADD_TRIGGER_TEST_ID}
            />
          ) : addControl}
        </div>
        {floatingControl && (
          <div className={styles.floatingControl}>
            {floatingControl}
          </div>
        )}
      </div>
    </div>
  );
}

function stopCanvasInteraction(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * The always-present element primitives: Text, Div, Span.
 *
 * Separate from `FavoriteNotchActions`, and deliberately NOT implemented as
 * seeded favourites. Favourites are the author's own shelf — reorderable,
 * undockable, and persisted per user — so anything put there can be removed,
 * and a design tool's most basic "drop an element" affordances must not be
 * one right-click away from disappearing. These three are fixed chrome; the
 * favourites bar sits to their right and still owns everything else.
 *
 * Div and Span are the SAME module (`base.container`, whose `tag` prop decides
 * the element). Span goes through the tag control's `custom` escape hatch
 * because `span` is not in `htmlTag.ts`'s built-in list. That is deliberate:
 * it is exactly how the HTML importer already stores an imported `<span>`
 * (`structurePreservation.test.ts`), so inserting one here and importing one
 * produce the same node rather than two representations of the same element.
 * Promoting `span` to a built-in choice would be a real improvement, but it
 * has to change the importer in the same breath or that agreement breaks.
 *
 * The modules shown here are filtered OUT of the favourites bar
 * (`PRIMITIVE_MODULE_IDS`) — `base.text` and `base.container` are both default
 * favourites, so without that the notch showed two identical "Add Text"
 * buttons. Filtering beats reseeding the defaults: favourites are persisted
 * per user, so an existing shelf would still carry its own Text and duplicate
 * anyway. Nothing is lost — a favourited Container is already in the bar, as
 * "Div".
 */
const PRIMITIVE_MODULE_IDS: ReadonlySet<string> = new Set(["base.text", "base.container"]);

/** One primitive: which module it writes, with which prop overrides. */
interface PrimitiveSpec {
  id: string;
  label: string;
  icon: IconComponent;
  moduleId: string;
  defaults?: Record<string, unknown>;
}

function PrimitiveNotchActions() {
  const insertModule = useInsertModule();

  // Each button both CLICKS and DRAGS. Click inserts at the current selection;
  // drag lands it exactly where the ghost says, in whichever frame the pointer
  // is over — `useCanvasInsertionDrag` resolves both through the same
  // `resolveInsertLocation`, so the two entry points cannot disagree.
  const canvasDrag = useCanvasInsertionDrag<PrimitiveSpec>({
    onDrop: (spec, location) => {
      const mod = registry.get(spec.moduleId);
      if (!mod) return false;
      return insertModule(mod, location, { defaults: resolveDefaults(mod, spec) }) !== null;
    },
  });

  const specs: PrimitiveSpec[] = [
    { id: "primitive-text", label: "Text", icon: TextGlyphIcon, moduleId: "base.text" },
    // Div and Span are the SAME module (`base.container`, whose `tag` prop
    // decides the element), so they cannot share its registry icon or they
    // would draw identically. Each wears the mark for what it writes.
    { id: "primitive-div", label: "Div", icon: FrameGlyphIcon, moduleId: "base.container" },
    {
      id: "primitive-span",
      label: "Span",
      icon: SectionGlyphIcon,
      moduleId: "base.container",
      defaults: { tag: CUSTOM_HTML_TAG_VALUE, customTag: "span" },
    },
  ];

  return (
    <>
      {specs.map((spec) => {
        const mod = registry.get(spec.moduleId);
        if (!mod) return null;
        return renderActionButton(
          {
            id: spec.id,
            label: spec.label,
            icon: spec.icon,
            onClick: () => {
              // The pointerup that ends a drag also fires a click on the
              // button it started from — which would insert a second copy at
              // the default location.
              if (canvasDrag.shouldSuppressClick()) return;
              insertModule(mod, undefined, { defaults: resolveDefaults(mod, spec) });
            },
          },
          {
            onPointerDown: (event) =>
              canvasDrag.startDrag(event, spec, `Drop ${spec.label.toLowerCase()}`),
          },
        );
      })}
      <CanvasInsertionDragOverlay drag={canvasDrag.drag}>
        {canvasDrag.drag && (
          <>
            <canvasDrag.drag.ghost.icon size={13} aria-hidden="true" />
            {canvasDrag.drag.ghost.label}
          </>
        )}
      </CanvasInsertionDragOverlay>
    </>
  );
}

/** A primitive's own prop overrides layered onto the module's defaults. */
function resolveDefaults(
  mod: { defaults?: Record<string, unknown> },
  spec: PrimitiveSpec,
): Record<string, unknown> {
  return { ...(mod.defaults ?? {}), ...(spec.defaults ?? {}) };
}

interface FavoriteMenuState {
  x: number;
  y: number;
  item: ModuleInserterItem;
}

function FavoriteNotchActions() {
  const insertModule = useInsertModule();
  const { favorites, setFavorites, toggleFavorite } = useModuleInserterPreference();
  const insertionContext = useModuleInsertionContext();
  const visualComponents = useEditorStore((s) => s.site?.visualComponents ?? EMPTY_COMPONENTS);
  const savedLayouts = useEditorStore((s) => s.site?.layouts ?? EMPTY_SAVED_LAYOUTS);
  const insertLayout = useEditorStore((s) => s.insertLayout);
  const canvasPage = useEditorStore(selectActiveCanvasPage);
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId);
  const insertComponentRef = useEditorStore((s) => s.insertComponentRef);
  const [menu, setMenu] = useState<FavoriteMenuState | null>(null);

  const { allItems } = buildModuleInserterItems({
    modules: registry.list(),
    context: insertionContext,
    savedLayouts,
    visualComponents,
  });
  const resolvedFavorites = resolveInserterRefs(favorites, allItems);
  const favoriteItems = (
    favorites.length > 0 && resolvedFavorites.length === 0
      ? resolveInserterRefs(DEFAULT_MODULE_INSERTER_FAVORITES, allItems)
      : resolvedFavorites
  ).filter((item) => !(item.kind === "module" && PRIMITIVE_MODULE_IDS.has(item.id)));

  function insertComponent(componentId: string) {
    if (!canvasPage) return;
    const location = resolveInsertLocation(
      canvasPage,
      selectedNodeId ?? canvasPage.rootNodeId,
    );
    if (!location) return;
    insertComponentRef(location.parentId, componentId, location.index);
  }

  // Reorder a favorite by swapping it with its visible neighbour. The swap
  // runs on the raw `favorites` ref array (keyed by item) so any favorites
  // that don't resolve against the current registry stay pinned in place.
  function moveFavorite(item: ModuleInserterItem, direction: "left" | "right") {
    const visibleIndex = favoriteItems.findIndex((fav) => fav.key === item.key);
    const neighbor = favoriteItems[visibleIndex + (direction === "left" ? -1 : 1)];
    if (!neighbor) return;
    const next = [...favorites];
    const from = next.findIndex((ref) => recentKey(ref) === item.key);
    const to = next.findIndex((ref) => recentKey(ref) === neighbor.key);
    if (from === -1 || to === -1) return;
    [next[from], next[to]] = [next[to], next[from]];
    setFavorites(next);
  }

  function undockFavorite(item: ModuleInserterItem) {
    toggleFavorite(recentRefForItem(item));
  }

  const menuIndex = menu
    ? favoriteItems.findIndex((fav) => fav.key === menu.item.key)
    : -1;
  const canMoveLeft = menuIndex > 0;
  const canMoveRight = menuIndex >= 0 && menuIndex < favoriteItems.length - 1;

  return (
    <>
      {favoriteItems.map((item) => {
        const action = actionForItem(item, {
          insertModule,
          insertComponent,
          insertLayout,
        });
        if (!action) return null;
        return renderActionButton(action, {
          onContextMenu: (event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, item });
          },
        });
      })}
      {menu &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            ariaLabel={`${menu.item.name} favorite options`}
            animateExit
            onClose={() => setMenu(null)}
          >
            <ContextMenuItem
              disabled={!canMoveLeft}
              onClick={() => {
                moveFavorite(menu.item, "left");
                setMenu(null);
              }}
            >
              <span aria-hidden="true">
                <ArrowLeftIcon size={13} />
              </span>
              Move left
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canMoveRight}
              onClick={() => {
                moveFavorite(menu.item, "right");
                setMenu(null);
              }}
            >
              <span aria-hidden="true">
                <ArrowRightIcon size={13} />
              </span>
              Move right
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              danger
              onClick={() => {
                undockFavorite(menu.item);
                setMenu(null);
              }}
            >
              <span aria-hidden="true">
                <CloseIcon size={13} />
              </span>
              Undock
            </ContextMenuItem>
          </ContextMenu>,
          document.body,
        )}
    </>
  );
}

function actionForItem(
  item: ModuleInserterItem,
  handlers: {
    insertModule: ReturnType<typeof useInsertModule>;
    insertComponent: (componentId: string) => void;
    insertLayout: (layoutId: string) => string | null;
  },
): CanvasNotchAction | null {
  if (item.kind === "module") {
    return {
      id: item.key,
      label: item.name,
      moduleId: item.id,
      onClick: () => handlers.insertModule(item.module),
      disabledReason: item.disabledReason,
    };
  }
  if (item.kind === "savedLayout") {
    return {
      id: item.key,
      label: item.name,
      icon: LayoutSolidIcon,
      onClick: () => handlers.insertLayout(item.id),
      disabledReason: item.disabledReason,
    };
  }
  if (item.kind === "component") {
    return {
      id: item.key,
      label: item.name,
      icon: BracesIcon,
      onClick: () => handlers.insertComponent(item.id),
    };
  }
  return null;
}

function renderActionButton(
  action: CanvasNotchAction,
  options?: {
    onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
    onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  },
) {
  const ActionIcon = action.icon;
  return (
    <Button
      key={action.id}
      variant="ghost"
      size="sm"
      iconOnly
      className={styles.quickButton}
      onClick={action.onClick}
      onContextMenu={options?.onContextMenu}
      onPointerDown={options?.onPointerDown}
      disabled={Boolean(action.disabledReason)}
      aria-label={`Add ${action.label}`}
      tooltip={action.disabledReason ?? `Add ${action.label}`}
      data-testid={`canvas-notch-${testIdPart(action.label)}-btn`}
    >
      {ActionIcon ? (
        <ActionIcon size={14} aria-hidden="true" />
      ) : (
        <ModuleIcon
          moduleId={action.moduleId}
          size={14}
          aria-hidden="true"
        />
      )}
    </Button>
  );
}

function testIdPart(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
