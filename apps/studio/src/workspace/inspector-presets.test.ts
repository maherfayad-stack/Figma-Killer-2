import { describe, expect, it } from 'vitest';
import {
  ALIGN_ITEMS_GROUP,
  arbitraryCornerRadiusEdit,
  arbitraryGapEdit,
  arbitraryInsetEdit,
  arbitraryPaddingLinkedEdit,
  arbitraryPaddingSideEdit,
  arbitrarySizeEdit,
  BLEND_MODE_GROUP,
  BORDER_WIDTH_GROUP,
  buildColorPalette,
  clamp01,
  colorClassWithAlpha,
  colorGroup,
  consolidateRadiusFromCorners,
  coScaleDimension,
  DIRECTION_GROUP,
  FILL_DEFAULT_CLASS,
  filterColorPalette,
  GAP_GROUP,
  hexToRgb,
  hsvToRgb,
  JUSTIFY_GROUP,
  normalizeHex,
  OPACITY_GROUP,
  ORDER_GROUP,
  parseBorderRadiusCorners,
  parseColorHint,
  POSITION_GROUP,
  RADIUS_GROUP,
  resolveAddFillEdit,
  resolveAddShadowEdit,
  resolveAddStrokeEdit,
  resolveClassEdit,
  resolveColorWrite,
  resolveRemoveFillEdit,
  resolveRemoveShadowEdit,
  resolveRemoveStrokeEdit,
  rgbToHex,
  rgbToHsv,
  SELF_ALIGN_GROUP,
  serializeColorHint,
  SHADOW_DEFAULT_VALUE,
  SHADOW_GROUP,
  STROKE_DEFAULT_COLOR_CLASS,
  STROKE_DEFAULT_WIDTH_CLASS,
  TEXT_SIZE_GROUP,
  tokenClassName,
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

describe('normalizeHex', () => {
  it('accepts a 6-digit hex with or without a leading #, lowercasing it', () => {
    expect(normalizeHex('#3B82F6')).toBe('#3b82f6');
    expect(normalizeHex('3B82F6')).toBe('#3b82f6');
  });

  it('expands a 3-digit shorthand hex', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('ABC')).toBe('#aabbcc');
  });

  it('rejects garbage input rather than guessing', () => {
    expect(normalizeHex('not-a-color')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });
});

describe('hex <-> rgb <-> hsv round trips', () => {
  it('hexToRgb decodes a known color', () => {
    expect(hexToRgb('#3b82f6')).toEqual({ r: 59, g: 130, b: 246 });
  });

  it('hexToRgb rejects invalid hex', () => {
    expect(hexToRgb('nope')).toBeNull();
  });

  it('rgbToHex re-encodes the same known color', () => {
    expect(rgbToHex({ r: 59, g: 130, b: 246 })).toBe('#3b82f6');
  });

  it('rgbToHex clamps and rounds out-of-range channel values', () => {
    expect(rgbToHex({ r: -10, g: 300, b: 127.6 })).toBe('#00ff80');
  });

  it('rgb -> hsv -> rgb round-trips a pure color', () => {
    const rgb = { r: 59, g: 130, b: 246 };
    const hsv = rgbToHsv(rgb);
    const back = hsvToRgb(hsv);
    expect(Math.round(back.r)).toBe(rgb.r);
    expect(Math.round(back.g)).toBe(rgb.g);
    expect(Math.round(back.b)).toBe(rgb.b);
  });

  it('white/black have zero saturation, differing only in value', () => {
    expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 100 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
  });
});

describe('colorClassWithAlpha', () => {
  it('omits the /NN modifier at 100 (or null) — Tailwind default, no needless class', () => {
    expect(colorClassWithAlpha('bg-blue-500', 100)).toBe('bg-blue-500');
    expect(colorClassWithAlpha('bg-blue-500', null)).toBe('bg-blue-500');
  });

  it('appends the rounded /NN modifier for a genuine partial value', () => {
    expect(colorClassWithAlpha('bg-blue-500', 50)).toBe('bg-blue-500/50');
    expect(colorClassWithAlpha('bg-blue-500', -20)).toBe('bg-blue-500/0');
  });

  it('clamps an out-of-range value >= 100 to the no-modifier case too', () => {
    expect(colorClassWithAlpha('bg-blue-500', 137.6)).toBe('bg-blue-500');
  });
});

describe('resolveColorWrite', () => {
  it('writes the base class + alpha modifier, no remove when nothing previous', () => {
    const edit = resolveColorWrite('bg-[#3b82f6]', 50, null);
    expect(edit.add).toEqual(['bg-[#3b82f6]/50']);
    expect(edit.remove).toEqual([]);
  });

  it('evicts this control\'s own previous write on change', () => {
    const edit = resolveColorWrite('bg-aqua-100', null, 'bg-[#3b82f6]/50');
    expect(edit.add).toEqual(['bg-aqua-100']);
    expect(edit.remove).toEqual(['bg-[#3b82f6]/50']);
  });

  it('never removes the class it just re-added (no-op re-pick)', () => {
    const edit = resolveColorWrite('bg-blue-500', 100, 'bg-blue-500');
    expect(edit.add).toEqual(['bg-blue-500']);
    expect(edit.remove).toEqual([]);
  });
});

describe('tokenClassName', () => {
  it('kebab-cases a camelCase/numeric DS token name for a Tailwind class suffix', () => {
    expect(tokenClassName('aqua100')).toBe('aqua-100');
    expect(tokenClassName('whiteStatic')).toBe('white-static');
  });
});

describe('serializeColorHint / parseColorHint', () => {
  const value = { hex: '#3b82f6', alphaPct: 50, baseClass: 'bg-[#3b82f6]', written: 'bg-[#3b82f6]/50' };

  it('round-trips a value through JSON', () => {
    expect(parseColorHint(serializeColorHint(value))).toEqual(value);
  });

  it('returns null for undefined, garbage, or shape-mismatched input — never a fabricated value', () => {
    expect(parseColorHint(undefined)).toBeNull();
    expect(parseColorHint('not json')).toBeNull();
    expect(parseColorHint(JSON.stringify({ hex: '#000' }))).toBeNull();
    expect(parseColorHint(JSON.stringify(null))).toBeNull();
  });
});

describe('buildColorPalette / filterColorPalette', () => {
  it('builds token entries first, then the named Tailwind palette, prefixed correctly', () => {
    const palette = buildColorPalette('bg', [{ name: 'aqua100', value: '#00bcd4' }], () => '#00bcd4');
    expect(palette[0]).toEqual({ key: 'token:aqua100', label: 'aqua100', hex: '#00bcd4', baseClass: 'bg-aqua-100' });
    expect(palette.some((e) => e.key === 'named:none' && e.baseClass === 'bg-transparent')).toBe(true);
    expect(palette.some((e) => e.key === 'named:blue-500' && e.baseClass === 'bg-blue-500')).toBe(true);
  });

  it('filterColorPalette matches case-insensitively on label, substring anywhere', () => {
    const palette = buildColorPalette('bg', [{ name: 'aqua100', value: '#00bcd4' }], () => '#00bcd4');
    expect(filterColorPalette(palette, 'AQUA').map((e) => e.key)).toEqual(['token:aqua100']);
    expect(filterColorPalette(palette, '').length).toBe(palette.length);
    expect(filterColorPalette(palette, 'zzz-no-match')).toEqual([]);
  });
});

describe('clamp01', () => {
  it('clamps to the unit interval', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});

describe('FIX-W4b-7 item 1 — BLEND_MODE_GROUP', () => {
  it('"normal" adds nothing and evicts every mix-blend-* candidate', () => {
    const edit = resolveClassEdit(BLEND_MODE_GROUP, 'normal');
    expect(edit.add).toEqual([]);
    expect(edit.remove).toEqual(expect.arrayContaining(['mix-blend-multiply', 'mix-blend-luminosity']));
  });

  it('choosing "multiply" adds mix-blend-multiply and evicts every OTHER blend candidate (self-contained, ast-engine has no mix-blend group)', () => {
    const edit = resolveClassEdit(BLEND_MODE_GROUP, 'multiply');
    expect(edit.add).toEqual(['mix-blend-multiply']);
    expect(edit.remove).toEqual(
      expect.arrayContaining(['mix-blend-screen', 'mix-blend-overlay', 'mix-blend-color-dodge', 'mix-blend-hue']),
    );
    expect(edit.remove).not.toContain('mix-blend-multiply');
  });

  it('switching between two non-normal modes never leaves both classes behind', () => {
    const toScreen = resolveClassEdit(BLEND_MODE_GROUP, 'screen');
    expect(toScreen.add).toEqual(['mix-blend-screen']);
    expect(toScreen.remove).toContain('mix-blend-multiply');
  });

  it('covers every Penpot blend-mode name (16 total, incl. normal)', () => {
    expect(BLEND_MODE_GROUP.presets.map((p) => p.value)).toEqual([
      'normal',
      'multiply',
      'screen',
      'overlay',
      'darken',
      'lighten',
      'color-dodge',
      'color-burn',
      'hard-light',
      'soft-light',
      'difference',
      'exclusion',
      'hue',
      'saturation',
      'color',
      'luminosity',
    ]);
  });
});

describe('FIX-W4b-7 item 2 — independent corner radius', () => {
  it('arbitraryCornerRadiusEdit writes rounded-<corner>-[Npx] and evicts every named single-radius preset', () => {
    const edit = arbitraryCornerRadiusEdit('tl', 12, null, null);
    expect(edit.add).toEqual(['rounded-tl-[12px]']);
    expect(edit.remove).toEqual(expect.arrayContaining(RADIUS_GROUP.presets.map((p) => p.add[0])));
  });

  it('evicts a previous SINGLE arbitrary radius when first switching into corner mode', () => {
    const edit = arbitraryCornerRadiusEdit('tr', 8, null, 'rounded-[10px]');
    expect(edit.add).toEqual(['rounded-tr-[8px]']);
    expect(edit.remove).toContain('rounded-[10px]');
  });

  it('evicts this SAME corner\'s previous arbitrary value on re-edit, never itself', () => {
    const edit = arbitraryCornerRadiusEdit('br', 20, 'rounded-br-[8px]', null);
    expect(edit.add).toEqual(['rounded-br-[20px]']);
    expect(edit.remove).toContain('rounded-br-[8px]');
    expect(edit.remove).not.toContain('rounded-br-[20px]');
  });

  it('a different corner\'s previous class never leaks into an unrelated corner\'s remove list', () => {
    const edit = arbitraryCornerRadiusEdit('bl', 4, null, null);
    expect(edit.remove).not.toContain('rounded-tl-[12px]');
  });

  it('consolidateRadiusFromCorners writes ONE rounded-[Npx] from the top-left value and clears every written corner', () => {
    const edit = consolidateRadiusFromCorners(16, ['rounded-tl-[16px]', 'rounded-tr-[8px]', null, 'rounded-bl-[4px]']);
    expect(edit.add).toEqual(['rounded-[16px]']);
    expect(edit.remove).toEqual(
      expect.arrayContaining(['rounded-tl-[16px]', 'rounded-tr-[8px]', 'rounded-bl-[4px]']),
    );
  });

  it('consolidateRadiusFromCorners is a no-op remove when no corner was ever written', () => {
    expect(consolidateRadiusFromCorners(10, [null, null, null, null]).remove).toEqual([]);
  });

  it('parseBorderRadiusCorners: a single token seeds all 4 corners the same', () => {
    expect(parseBorderRadiusCorners('10px')).toEqual({ tl: 10, tr: 10, br: 10, bl: 10 });
  });

  it('parseBorderRadiusCorners: 4 tokens map to tl/tr/br/bl in CSS shorthand order', () => {
    expect(parseBorderRadiusCorners('10px 20px 30px 40px')).toEqual({ tl: 10, tr: 20, br: 30, bl: 40 });
  });

  it('parseBorderRadiusCorners: 2 tokens fold to tl=br, tr=bl (CSS shorthand repeat rule)', () => {
    expect(parseBorderRadiusCorners('10px 20px')).toEqual({ tl: 10, tr: 20, br: 10, bl: 20 });
  });

  it('parseBorderRadiusCorners: 3 tokens fold tr=bl (CSS shorthand repeat rule)', () => {
    expect(parseBorderRadiusCorners('10px 20px 30px')).toEqual({ tl: 10, tr: 20, br: 30, bl: 20 });
  });

  it('parseBorderRadiusCorners rejects an elliptical (/-separated) radius, never guessing', () => {
    expect(parseBorderRadiusCorners('10px 20px / 5px 10px')).toBeNull();
  });

  it('parseBorderRadiusCorners rejects a non-px unit or garbage, never guessing', () => {
    expect(parseBorderRadiusCorners('1em')).toBeNull();
    expect(parseBorderRadiusCorners('')).toBeNull();
    expect(parseBorderRadiusCorners('10px 20px 30px 40px 50px')).toBeNull();
  });
});

describe('FIX-W4b-7 item 3 — coScaleDimension (aspect-ratio lock)', () => {
  it('editing W scales H to preserve the current W:H ratio', () => {
    expect(coScaleDimension('w', 200, 100, 50)).toBe(100); // 2:1 ratio, new W=200 -> H=100
  });

  it('editing H scales W to preserve the current W:H ratio', () => {
    expect(coScaleDimension('h', 100, 100, 50)).toBe(200); // 2:1 ratio, new H=100 -> W=200
  });

  it('rounds to the nearest whole pixel', () => {
    expect(coScaleDimension('w', 100, 300, 200)).toBe(67); // 3:2 ratio -> 66.67 rounds to 67
  });

  it('returns null (never a fabricated write) for a non-finite or non-positive basis', () => {
    expect(coScaleDimension('w', 100, 0, 50)).toBeNull();
    expect(coScaleDimension('w', 100, Number.NaN, 50)).toBeNull();
    expect(coScaleDimension('w', -10, 100, 50)).toBeNull();
  });
});

describe('FIX-W4b-6 — Fill/Stroke/Shadow add/remove edits', () => {
  it('resolveAddFillEdit: `+` writes exactly bg-white, nothing to remove', () => {
    expect(FILL_DEFAULT_CLASS).toBe('bg-white');
    expect(resolveAddFillEdit()).toEqual({ add: ['bg-white'], remove: [] });
  });

  it('resolveRemoveFillEdit: `-` strips exactly the class it was given, adds nothing', () => {
    expect(resolveRemoveFillEdit('bg-[#3b82f6]/50')).toEqual({ add: [], remove: ['bg-[#3b82f6]/50'] });
    expect(resolveRemoveFillEdit('bg-sky-600')).toEqual({ add: [], remove: ['bg-sky-600'] });
  });

  it('resolveAddStrokeEdit: `+` writes border + border-black, nothing to remove', () => {
    expect(STROKE_DEFAULT_WIDTH_CLASS).toBe('border');
    expect(STROKE_DEFAULT_COLOR_CLASS).toBe('border-black');
    expect(resolveAddStrokeEdit()).toEqual({ add: ['border', 'border-black'], remove: [] });
  });

  it('resolveRemoveStrokeEdit: `-` strips every BORDER_WIDTH_GROUP candidate plus the given color class', () => {
    const edit = resolveRemoveStrokeEdit('border-red-500');
    expect(edit.add).toEqual([]);
    expect(edit.remove).toEqual(
      expect.arrayContaining([...BORDER_WIDTH_GROUP.presets.flatMap((p) => p.add), 'border-red-500']),
    );
  });

  it('resolveAddShadowEdit: `+` writes shadow-md and evicts every other shadow candidate', () => {
    expect(SHADOW_DEFAULT_VALUE).toBe('md');
    const edit = resolveAddShadowEdit();
    expect(edit.add).toEqual(['shadow-md']);
    expect(edit.remove).toEqual(
      expect.arrayContaining(['shadow-none', 'shadow-sm', 'shadow', 'shadow-lg', 'shadow-xl', 'shadow-2xl', 'shadow-inner']),
    );
  });

  it('resolveRemoveShadowEdit: `-` strips every real shadow-casting class, adds nothing, never re-adds shadow-none', () => {
    const edit = resolveRemoveShadowEdit();
    expect(edit.add).toEqual([]);
    expect(edit.remove).toEqual(
      expect.arrayContaining(['shadow-sm', 'shadow', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl', 'shadow-inner']),
    );
    expect(edit.remove).not.toContain('shadow-none');
  });
});
