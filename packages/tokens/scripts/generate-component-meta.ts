/**
 * FIX-W3 `.meta.ts` generator — BUILD-TIME TOOL, run manually:
 *
 *   node packages/tokens/scripts/generate-component-meta.ts
 *   node packages/tokens/scripts/generate-component-meta.ts --force   # overwrite existing .meta.ts
 *   node packages/tokens/scripts/generate-component-meta.ts --dry-run # print, don't write
 *
 * Writes `<Name>.meta.ts` files into `design-system/src/components/` — the
 * JUNCTIONED, external `design-system` git repo (ADR-0008), NOT this
 * monorepo. Those files will NOT show up in `git status` at this repo's
 * root; they live (and must eventually be committed) in the sibling
 * `design-system` checkout. This is a considered exception to "studio makes
 * zero fs writes": this is a human-run CLI script, never invoked by the
 * daemon or the studio app at runtime (see `generate-meta.ts`'s module doc
 * for the pure-logic core this wraps).
 *
 * NOT every exported `design-system` component gets a `.meta.ts` here —
 * only a curated CORE set of self-contained "leaf" components that render
 * something visible with zero required props/children (per the FIX-W3
 * brief: "prefer correctness for a solid core set over shallow coverage of
 * all ~50"). Data/content cards (BookingVoucherCard, HotelDealCard, trip
 * sections, ...) genuinely need real data to paint anything meaningful and
 * are deliberately left out — flagged below, not silently skipped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateComponentMeta, serializeComponentMeta } from '../src/generate-meta.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(HERE, '..', '..', '..', 'design-system', 'src', 'components');

interface CoreEntry {
  name: string;
  file: string;
  category: string;
  description: string;
}

// The curated CORE set — every entry is a component verified (by reading
// its .jsx) to render something visible with zero props passed, using only
// its own JS default parameters + sibling .css.
const CORE_COMPONENTS: CoreEntry[] = [
  { name: 'Badge', file: 'Badge', category: 'Feedback', description: 'Count/status pip, optionally anchored to children.' },
  { name: 'Button', file: 'Button', category: 'Actions', description: 'Primary call-to-action button.' },
  { name: 'IconButton', file: 'IconButton', category: 'Actions', description: 'Icon-only circular/square action button.' },
  { name: 'Accolade', file: 'Accolade', category: 'Content', description: 'Sparkle-icon accent label.' },
  { name: 'Highlight', file: 'Highlight', category: 'Content', description: 'Inline highlighted label with an icon.' },
  { name: 'Banner', file: 'Banner', category: 'Feedback', description: 'Dismissible promo/status banner.' },
  { name: 'Tag', file: 'Tag', category: 'Content', description: 'Small labeled pill.' },
  { name: 'ListItem', file: 'List', category: 'Layout', description: 'A single row in a list (icon/radio/checkbox variants).' },
  { name: 'Cell', file: 'Cell', category: 'Layout', description: 'Settings-style row cell with leading visual + trailing control.' },
  { name: 'Separator', file: 'Separator', category: 'Layout', description: 'Thin dividing line.' },
  { name: 'Expander', file: 'Expander', category: 'Layout', description: 'Collapsible disclosure section.' },
  { name: 'Checkbox', file: 'Checkbox', category: 'Forms', description: 'Checkbox input with label.' },
  { name: 'Radio', file: 'Radio', category: 'Forms', description: 'Radio input with label.' },
  { name: 'Toggle', file: 'Toggle', category: 'Forms', description: 'On/off switch.' },
  { name: 'TextInput', file: 'TextInput', category: 'Forms', description: 'Single-line text field.' },
  { name: 'Search', file: 'Search', category: 'Forms', description: 'Search input field.' },
  { name: 'Slider', file: 'Slider', category: 'Forms', description: 'Range slider.' },
  { name: 'SegmentedControl', file: 'SegmentedControl', category: 'Forms', description: 'Segmented tab switcher.' },
  { name: 'FilterChip', file: 'FilterChip', category: 'Forms', description: 'Toggleable filter pill.' },
  { name: 'Tooltip', file: 'Tooltip', category: 'Feedback', description: 'Contextual hint bubble.' },
  { name: 'Snackbar', file: 'Snackbar', category: 'Feedback', description: 'Transient bottom notification.' },
  { name: 'ProgressStepper', file: 'ProgressStepper', category: 'Feedback', description: 'Linear step-progress indicator.' },
  { name: 'Stepper', file: 'Stepper', category: 'Navigation', description: 'Numbered step indicator with labels.' },
  { name: 'TabBar', file: 'TabBar', category: 'Navigation', description: 'Bottom tab navigation bar.' },
  { name: 'Navbar', file: 'Navbar', category: 'Navigation', description: 'Top navigation bar.' },
  { name: 'BottomActionBar', file: 'BottomActionBar', category: 'Navigation', description: 'Fixed bottom action bar.' },
  { name: 'SectionTitle', file: 'SectionTitle', category: 'Content', description: 'Section heading with optional action.' },
  { name: 'AlmosaferLogo', file: 'AlmosaferLogo', category: 'Content', description: 'Almosafer wordmark/symbol logo.' },
];

// Exported from design-system/src/index.js but deliberately NOT generated —
// each genuinely needs real data/children to paint anything meaningful, so
// auto-defaulting them would either render truly empty or require guessing
// fake business data. Left for a future worker with real fixture data.
const FLAGGED_NEEDS_DATA = [
  'BottomSheet', 'MarketingCard', 'MarketingDealsSection', 'HeroCard', 'HeroSection', 'WelcomeWidget',
  'UpcomingTripCard', 'UpcomingTripSection', 'UpcomingTripStackGroup', 'CrossSellAddonsCard', 'StayUpsellCard',
  'StatusUpdateNote', 'BookingFlightStatusStrip', 'BookingReferenceRow', 'PostBookingProductCard',
  'BookedAddonOfferCard', 'BookingAddonsSection', 'HotelDealCard', 'HotelCrossSellSection', 'PurchasedAddonCard',
  'BookingVoucherCard', 'BookingInfoCell', 'BookingMoreInformation', 'BookingDetailsContent', 'FlightLegHeadline',
  'FlightDetailsCard', 'FlightFareRulesCard', 'FlightRewardsCard', 'FlightDetailsContent',
  'LineIcon', 'SarIcon', 'GearIcon', 'VisualIcon', // icon primitives — need a `src`/path to show anything
];

function main(): void {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const dryRun = args.has('--dry-run');

  let generated = 0;
  let skippedExisting = 0;
  const allWarnings: string[] = [];

  for (const entry of CORE_COMPONENTS) {
    // Named after the SOURCE FILE, not the exported component — matches the
    // ADR-0021 convention (a `.meta.ts` lives next to its `.jsx`; one file
    // can export more than one component, e.g. `ListItem` is authored in
    // `List.meta.ts` next to `List.jsx`). `catalog.ts` matches by the
    // `name` field INSIDE the file, so this only affects the filename.
    const metaPath = join(COMPONENTS_DIR, `${entry.file}.meta.ts`);
    if (existsSync(metaPath) && !force) {
      skippedExisting++;
      continue;
    }

    const jsxPath = join(COMPONENTS_DIR, `${entry.file}.jsx`);
    const cssPath = join(COMPONENTS_DIR, `${entry.file}.css`);
    const jsxText = readFileSync(jsxPath, 'utf8');
    const cssText = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';

    const { meta, warnings } = generateComponentMeta({
      name: entry.name,
      jsxText,
      cssText,
      category: entry.category,
      description: entry.description,
    });

    if (Object.keys(meta.props).length === 0) {
      console.warn(`[generate-component-meta] ${entry.name}: no destructured props found — check the .jsx shape`);
    }
    for (const w of warnings) allWarnings.push(`${entry.name}: ${w}`);

    const text = serializeComponentMeta(meta, { sourceJsxFile: `${entry.file}.jsx` });
    if (dryRun) {
      console.log(`\n--- ${entry.name}.meta.ts ---\n${text}`);
    } else {
      writeFileSync(metaPath, text, 'utf8');
    }
    generated++;
  }

  console.log(
    `\n[generate-component-meta] ${dryRun ? '(dry-run) ' : ''}generated ${generated}, ` +
      `skipped ${skippedExisting} (already had a .meta.ts — pass --force to regenerate).`,
  );
  console.log(`[generate-component-meta] flagged (need real data/children, not generated): ${FLAGGED_NEEDS_DATA.length}`);
  if (allWarnings.length > 0) {
    console.log(`[generate-component-meta] ${allWarnings.length} per-prop fallback warnings:`);
    for (const w of allWarnings) console.log(`  - ${w}`);
  }
  console.log(
    `[generate-component-meta] NOTE: these files were written into the JUNCTIONED design-system/ ` +
      `repo (a separate git checkout, ADR-0008) — they will NOT appear in this monorepo's \`git status\`.`,
  );
}

main();
