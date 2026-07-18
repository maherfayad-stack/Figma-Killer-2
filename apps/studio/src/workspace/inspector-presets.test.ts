import { describe, expect, it } from 'vitest';
import {
  ALIGN_ITEMS_GROUP,
  arbitraryGapEdit,
  arbitraryInsetEdit,
  arbitraryPaddingLinkedEdit,
  arbitraryPaddingSideEdit,
  arbitrarySizeEdit,
  colorGroup,
  DIRECTION_GROUP,
  GAP_GROUP,
  JUSTIFY_GROUP,
  OPACITY_GROUP,
  ORDER_GROUP,
  POSITION_GROUP,
  RADIUS_GROUP,
  resolveClassEdit,
  SELF_ALIGN_GROUP,
  SHADOW_GROUP,
  TEXT_SIZE_GROUP,
  WIDTH_GROUP,
} from './inspector-presets.js';

describe('resolveClassEdit', () => {
  it('direction: choosing "col" adds flex+flex-col and removes every other direction candidate (keeps flex)', () => {
    const edit = resolveClassEdit(DIRECTION_GROUP, 'col');
    expect(edit.add).toEqual(['flex', 'flex-col']);
    expect(edit.remove).toEqual(
      expect.arrayContaining(['flex-row', 'flex-row-reverse', 'flex-col-reverse']),
    );
    expect(edit.remove).not.toContain('flex'); // still asserted by the chosen preset itself
    expect(edit.remove).not.toContain('flex-col');
  });

  it('justify: switching between two presets never leaves both classes behind', () => {
    const toCenter = resolveClassEdit(JUSTIFY_GROUP, 'center');
    expect(toCenter.add).toEqual(['justify-center']);
    expect(toCenter.remove).toContain('justify-start');
    expect(toCenter.remove).not.toContain('justify-center');
  });

  it('align-items: covers every candidate exactly once', () => {
    const edit = resolveClassEdit(ALIGN_ITEMS_GROUP, 'stretch');
    expect(edit.add).toEqual(['items-stretch']);
    expect(edit.remove.sort()).toEqual(
      ['items-start', 'items-center', 'items-end', 'items-baseline'].sort(),
    );
  });

  it('gap: numeric scale maps 1:1 to gap-<n>', () => {
    expect(resolveClassEdit(GAP_GROUP, '4').add).toEqual(['gap-4']);
  });

  it('self-align (untracked by @ccs/ast-engine tailwind-groups): still evicts the prior self-* on change', () => {
    const edit = resolveClassEdit(SELF_ALIGN_GROUP, 'end');
    expect(edit.add).toEqual(['self-end']);
    expect(edit.remove).toEqual(
      expect.arrayContaining(['self-auto', 'self-start', 'self-center', 'self-stretch', 'self-baseline']),
    );
  });

  it('order (untracked): numeric + first/last/none are mutually exclusive', () => {
    const edit = resolveClassEdit(ORDER_GROUP, '3');
    expect(edit.add).toEqual(['order-3']);
    expect(edit.remove).toEqual(expect.arrayContaining(['order-first', 'order-last', 'order-none', 'order-1']));
    expect(edit.remove).not.toContain('order-3');
  });

  it('radius: "default" maps to bare `rounded`, not `rounded-default`', () => {
    expect(resolveClassEdit(RADIUS_GROUP, 'default').add).toEqual(['rounded']);
  });

  it('shadow: nearest Tailwind preset, never an arbitrary value', () => {
    const edit = resolveClassEdit(SHADOW_GROUP, 'lg');
    expect(edit.add).toEqual(['shadow-lg']);
    expect(edit.remove).toEqual(expect.arrayContaining(['shadow-none', 'shadow-sm', 'shadow', 'shadow-2xl', 'shadow-inner']));
  });

  it('opacity: percentage value maps to opacity-<n>', () => {
    expect(resolveClassEdit(OPACITY_GROUP, '50').add).toEqual(['opacity-50']);
  });

  it('position: choosing "absolute" adds `absolute`; choosing "static" removes it and adds nothing', () => {
    expect(resolveClassEdit(POSITION_GROUP, 'absolute').add).toEqual(['absolute']);
    const back = resolveClassEdit(POSITION_GROUP, 'static');
    expect(back.add).toEqual([]);
    expect(back.remove).toContain('absolute');
  });

  it('color palette: prefixes correctly per section (bg/text/border) and "none" maps to <prefix>-transparent', () => {
    expect(resolveClassEdit(colorGroup('bg'), 'blue-500').add).toEqual(['bg-blue-500']);
    expect(resolveClassEdit(colorGroup('text'), 'blue-500').add).toEqual(['text-blue-500']);
    expect(resolveClassEdit(colorGroup('border'), 'blue-500').add).toEqual(['border-blue-500']);
    expect(resolveClassEdit(colorGroup('bg'), 'none').add).toEqual(['bg-transparent']);
  });

  it('unknown value resolves to a no-op add with every candidate still removable', () => {
    const edit = resolveClassEdit(TEXT_SIZE_GROUP, 'not-a-real-size');
    expect(edit.add).toEqual([]);
    expect(edit.remove.length).toBeGreaterThan(0);
  });
});

describe('arbitrarySizeEdit', () => {
  it('builds a bracketed arbitrary-value class and removes every named width preset', () => {
    const edit = arbitrarySizeEdit('w', 240, null);
    expect(edit.add).toEqual(['w-[240px]']);
    expect(edit.remove).toEqual(expect.arrayContaining(WIDTH_GROUP.presets.map((p) => p.add[0])));
  });

  it('re-entering a custom value removes the PREVIOUS arbitrary class, not just named presets', () => {
    const edit = arbitrarySizeEdit('w', 300, 'w-[240px]');
    expect(edit.add).toEqual(['w-[300px]']);
    expect(edit.remove).toContain('w-[240px]');
  });

  it('rounds fractional pixel input', () => {
    expect(arbitrarySizeEdit('h', 199.6, null).add).toEqual(['h-[200px]']);
  });
});

describe('arbitraryGapEdit', () => {
  it('builds a bracketed gap class and removes every named gap-scale preset', () => {
    const edit = arbitraryGapEdit(16, null);
    expect(edit.add).toEqual(['gap-[16px]']);
    expect(edit.remove).toEqual(expect.arrayContaining(GAP_GROUP.presets.map((p) => p.add[0])));
  });

  it('re-entering a value removes the PREVIOUS arbitrary gap class too', () => {
    const edit = arbitraryGapEdit(24, 'gap-[16px]');
    expect(edit.add).toEqual(['gap-[24px]']);
    expect(edit.remove).toContain('gap-[16px]');
  });
});

describe('arbitraryPaddingSideEdit', () => {
  it('top writes the physical pt-[Npx] class', () => {
    expect(arbitraryPaddingSideEdit('top', 12, []).add).toEqual(['pt-[12px]']);
  });

  it('start/end write the LOGICAL ps-[Npx]/pe-[Npx] classes, not physical pl-/pr-', () => {
    expect(arbitraryPaddingSideEdit('start', 8, []).add).toEqual(['ps-[8px]']);
    expect(arbitraryPaddingSideEdit('end', 8, []).add).toEqual(['pe-[8px]']);
  });

  it('evicts a previously-cached value passed in (e.g. a stale linked-mode class on the same side)', () => {
    const edit = arbitraryPaddingSideEdit('top', 20, ['pt-[8px]', null]);
    expect(edit.remove).toContain('pt-[8px]');
    expect(edit.add).toEqual(['pt-[20px]']);
  });

  it('never removes the class it just added', () => {
    const edit = arbitraryPaddingSideEdit('bottom', 4, ['pb-[4px]']);
    expect(edit.remove).not.toContain('pb-[4px]');
  });
});

describe('arbitraryPaddingLinkedEdit', () => {
  it('vertical adds BOTH pt-[Npx] and pb-[Npx] (Penpot simple-mode fold-back, not a py- shorthand)', () => {
    const edit = arbitraryPaddingLinkedEdit('vertical', 16, [null, null]);
    expect(edit.add).toEqual(['pt-[16px]', 'pb-[16px]']);
  });

  it('horizontal adds the LOGICAL ps-[Npx]/pe-[Npx] pair, not a physical px- shorthand', () => {
    const edit = arbitraryPaddingLinkedEdit('horizontal', 10, [null, null]);
    expect(edit.add).toEqual(['ps-[10px]', 'pe-[10px]']);
  });

  it('evicts prior per-side values when folding two independent sides back into one linked value', () => {
    const edit = arbitraryPaddingLinkedEdit('vertical', 12, ['pt-[4px]', 'pb-[8px]']);
    expect(edit.remove).toEqual(expect.arrayContaining(['pt-[4px]', 'pb-[8px]']));
    expect(edit.add).toEqual(['pt-[12px]', 'pb-[12px]']);
  });
});

describe('arbitraryInsetEdit', () => {
  it('writes the FP-4b-matching logical inset class (start-[Npx]/top-[Npx])', () => {
    expect(arbitraryInsetEdit('start', 120, null).add).toEqual(['start-[120px]']);
    expect(arbitraryInsetEdit('top', 48, null).add).toEqual(['top-[48px]']);
  });

  it('removes a previous same-axis value on change, leaves an unrelated axis alone', () => {
    const edit = arbitraryInsetEdit('start', 10, 'start-[120px]');
    expect(edit.add).toEqual(['start-[10px]']);
    expect(edit.remove).toEqual(['start-[120px]']);
  });

  it('is a no-op remove when nothing previously written', () => {
    expect(arbitraryInsetEdit('top', 10, null).remove).toEqual([]);
  });
});
