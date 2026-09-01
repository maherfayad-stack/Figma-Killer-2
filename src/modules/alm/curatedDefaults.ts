/**
 * curatedDefaults — what the package's own docs cannot say, supplied once, per
 * component.
 *
 * Everything else an inserted component starts with is read out of
 * `manifest.generated.json` (`buildDesignSystemManifest`) — the package's
 * documented value for its own props — and that is deliberately the only
 * source, because a default Studio invents is design nobody asked for.
 *
 * A separate module from `register.tsx` for the reason its own list says: an
 * entry here is a CLAIM that the docs are incomplete, and it stops updating
 * when the package does. That is worth being able to read on its own.
 */
import chaletIcon from '@alm-design/design-system/src/icons/line-icons/chalet.svg?raw'
import compassIcon from '@alm-design/design-system/src/icons/line-icons/compass.svg?raw'
import calendarStartIcon from '@alm-design/design-system/src/icons/line-icons/calendarStart.svg?raw'
import discountIcon from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import userCircleIcon from '@alm-design/design-system/src/icons/line-icons/userCircle.svg?raw'

/**
 * What the package's own docs cannot say, supplied once, per component.
 *
 * Everything else an inserted component starts with is read out of
 * `manifest.generated.json` — the package's documented value for its own props
 * — and that is deliberately the only source, because a default Studio invents
 * is design nobody asked for. Two facts about a `TabBar` are simply not in the
 * doc block, and both were visible defects:
 *
 *  - **The icons.** The docs write `icon: <HomeIcon />` inside the example,
 *    which has no JSON form, so the docs pass drops it and every tab arrived as
 *    a label above an empty 24px slot. The icons themselves ship in the package
 *    (`src/icons/line-icons/`), and its own TabBar section names the set to use.
 *  - **The count.** The doc snippet shows three tabs; the same section says a
 *    tab bar holds "3–5 top-level destinations", and this product's has five.
 *
 * The labels are the product's, given by its owner — `design.md`'s content rules
 * ("1 word per tab; noun; matches the product vertical name exactly") say what
 * shape they take and cannot say what they are.
 *
 * The icons are carried as `{ svg: markup }` — the shape the parser captures a
 * JSX icon as (`ICON_PROP_SVG_KEY`), which `reviveIconProps` renders and
 * `insertableJsxProps` turns back into a real `<svg>` element on the way to the
 * user's source. Imported with `?raw` so they track the installed package
 * instead of pinning a copy of today's paths.
 *
 * Keep this list SHORT. An entry here is a claim the docs are incomplete, and
 * every one of them is a default that stops updating when the package does.
 */
export const CURATED_DEFAULTS: Record<string, Record<string, unknown>> = {
  TabBar: {
    items: [
      { icon: { svg: chaletIcon }, label: 'Home' },
      { icon: { svg: compassIcon }, label: 'Explore' },
      { icon: { svg: calendarStartIcon }, label: 'My Trips' },
      { icon: { svg: discountIcon }, label: 'Top offers' },
      { icon: { svg: userCircleIcon }, label: 'Profile' },
    ],
  },
}
