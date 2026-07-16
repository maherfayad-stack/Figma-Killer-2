import type { SVGProps } from 'react';
import { ICON_PATHS, type IconName } from './registry.js';

export type { IconName };

const SIZES = {
  12: 12,
  16: 16,
  32: 32,
} as const;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'width' | 'height'> {
  /** Which vendored Penpot icon to render (see `./registry.ts` for the full list). */
  name: IconName;
  /** Penpot's three icon sizes — `s=12 / m=16(default) / l=32`. */
  size?: 12 | 16 | 32;
}

/**
 * Renders one of the vendored Penpot icons (see `./penpot/*.svg` +
 * `NOTICE` for provenance/licensing) as an inline `<svg>`.
 *
 * Deliberately does NOT bake in a color or stroke-width: Penpot's own
 * `.icon` rule is `fill: none; stroke: currentColor;` — every vendored
 * icon (bar two that carry redundant inline attrs matching the same
 * defaults) is drawn as line art meant to inherit color from the CSS
 * `color` property, so consumers style icons via `color` /
 * `--ccs-icon(-hover|-active)`, never a prop.
 *
 * Path data is inlined into a typed TS registry (`registry.ts`) rather
 * than loaded through a bundler SVG transform — this works regardless of
 * whatever bundler `@ccs/ui`'s consumers use, no `?react`/svgr config
 * required.
 */
export function Icon({ name, size = 16, ...svgProps }: IconProps) {
  const d = ICON_PATHS[name];
  const px = SIZES[size];

  return (
    <svg
      viewBox="0 0 16 16"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...svgProps}
    >
      <path d={d} />
    </svg>
  );
}
