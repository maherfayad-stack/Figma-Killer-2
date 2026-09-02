/**
 * Section — shared inspector section primitive.
 *
 * A section is a titled block separated from its neighbours by a hairline —
 * Figma's right-sidebar anatomy, and the reason the header carries no chip,
 * no fill and no radius of its own. The chrome used to be a rounded
 * `--overlay-10` pill per section, which at nine sections turned the panel
 * into a stack of buttons with the actual controls as an afterthought.
 *
 * The title doubles as the disclosure toggle. Figma's sections are not
 * collapsible, but this panel has half again as many of them, so collapse
 * stays — drawn as a chevron that only surfaces on hover/focus, so a resting
 * panel reads as flat blocks rather than as a row of accordions.
 *
 * `actions` is the header's trailing slot: the small icon buttons Figma puts
 * flush right of a section title (apply a style, add a fill, open settings).
 * It sits OUTSIDE the toggle button — nesting a control inside a control is
 * invalid HTML and unreachable by keyboard.
 *
 * The optional `indicator` prop renders a small dot next to the title to
 * signal that the section has active state (stored class styles, active
 * breakpoint overrides, etc.).
 */

import { useState } from "react";
import type { IconComponent } from "pixel-art-icons/types";
import { ChevronRightIcon } from "pixel-art-icons/icons/chevron-right";
import { cn } from "@ui/cn";
import styles from "./Section.module.css";

interface SectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** Render a small dot next to the title to signal active state. */
  indicator?: boolean;
  indicatorTestId?: string;
  icon?: IconComponent;
  meta?: React.ReactNode;
  forceOpen?: boolean;
  /**
   * Trailing header slot — icon buttons flush right of the title (Figma's
   * "apply style" / "add" affordances). Rendered outside the toggle button
   * so its controls are independently clickable and focusable.
   */
  actions?: React.ReactNode;
  /**
   * Drop the section's own vertical padding so spacing comes entirely from the
   * parent container's grid gap (the borderless-tile / 1px-gap card pattern).
   * Used by the Properties panel; panels that rely on the section's own padding
   * for inter-section spacing (Data inspector) leave this off.
   */
  flush?: boolean;
}

export function Section({
  title,
  children,
  defaultOpen = false,
  indicator = false,
  indicatorTestId,
  icon: SectionIcon,
  meta,
  forceOpen = false,
  actions,
  flush = false,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = forceOpen || open;

  return (
    <div className={cn(styles.section, flush && styles.sectionFlush, expanded && styles.sectionOpen)}>
      <div className={styles.sectionHeader}>
        <button
          onClick={() => {
            if (!forceOpen) setOpen((o) => !o);
          }}
          className={styles.sectionToggle}
          aria-expanded={expanded}
        >
          {/*
            * The section's identity mark and its disclosure chevron share one
            * 16px box, cross-fading on hover. Two boxes would either indent
            * every title by the width of a control that is invisible at rest,
            * or hang the chevron outside the header on a negative margin. One
            * box costs nothing and reads correctly: the icon says what the
            * section is, and pointing at it shows you it opens.
            */}
          {(SectionIcon || !forceOpen) && (
            <span className={styles.sectionMarker} aria-hidden="true">
              {SectionIcon && (
                <span className={styles.sectionMarkerIcon}>
                  <SectionIcon size={13} />
                </span>
              )}
              {!forceOpen && (
                <span
                  className={cn(
                    styles.sectionMarkerChevron,
                    expanded && styles.sectionMarkerChevronOpen,
                  )}
                >
                  <ChevronRightIcon size={12} />
                </span>
              )}
            </span>
          )}
          <span className={styles.sectionTitleGroup}>
            <span className={styles.sectionTitle}>{title}</span>
            {indicator && (
              <span
                className={styles.sectionIndicatorDot}
                data-testid={indicatorTestId}
                aria-hidden="true"
              />
            )}
          </span>
          {meta && <span className={styles.sectionMeta}>{meta}</span>}
        </button>
        {actions && <span className={styles.sectionActions}>{actions}</span>}
      </div>
      {expanded && <div className={styles.sectionContent}>{children}</div>}
    </div>
  );
}
