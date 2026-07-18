import { describe, expect, it } from 'vitest';
import type { ComputedStyleRow } from '@ccs/canvas';
import {
  buildComputedLookup,
  formatCurrentValue,
  resolveCurrentValue,
} from './inspector-computed-values.js';
import { DIRECTION_GROUP, TEXT_SIZE_GROUP, JUSTIFY_GROUP } from './inspector-presets.js';

const rows = (entries: Array<[string, string]>): ComputedStyleRow[] =>
  entries.map(([prop, value]) => ({ group: 'layout', prop, value }));

describe('inspector-computed-values', () => {
  describe('buildComputedLookup', () => {
    it('returns null (loading) for null rows — distinct from an empty map', () => {
      expect(buildComputedLookup(null)).toBeNull();
    });
    it('indexes rows by prop', () => {
      const lookup = buildComputedLookup(rows([['font-size', '36px']]));
      expect(lookup?.get('font-size')).toBe('36px');
    });
  });

  describe('resolveCurrentValue — honesty rule', () => {
    it('reports loading when the bridge has not answered (null lookup)', () => {
      expect(resolveCurrentValue(null, 'font-size')).toBe('loading');
    });

    it('reports "unset" (never a fabricated token) when the prop is absent/empty', () => {
      const lookup = buildComputedLookup(rows([['color', 'rgb(0,0,0)']]));
      expect(resolveCurrentValue(lookup, 'font-size', TEXT_SIZE_GROUP)).toBe('unset');
    });

    it('ALWAYS returns the raw computed value when present', () => {
      const lookup = buildComputedLookup(rows([['font-size', '36px']]));
      expect(resolveCurrentValue(lookup, 'font-size', TEXT_SIZE_GROUP)).toEqual({ raw: '36px', label: null });
    });

    it('never reverse-maps a NUMERIC scale to a token (36px is NOT guessed back to text-4xl)', () => {
      const lookup = buildComputedLookup(rows([['font-size', '36px']]));
      const result = resolveCurrentValue(lookup, 'font-size', TEXT_SIZE_GROUP);
      expect(result).not.toBe('unset');
      if (result === 'loading' || result === 'unset') throw new Error('unreachable');
      expect(result.label).toBeNull(); // raw only, no fabricated token label
    });

    it('relabels ONLY on an exact CSS-keyword equivalence (flex-direction:column -> col)', () => {
      const lookup = buildComputedLookup(rows([['flex-direction', 'column']]));
      const result = resolveCurrentValue(lookup, 'flex-direction', DIRECTION_GROUP);
      expect(result).toEqual({ raw: 'column', label: 'Column' });
    });

    it('relabels justify-content:flex-start -> Start via the keyword alias', () => {
      const lookup = buildComputedLookup(rows([['justify-content', 'flex-start']]));
      const result = resolveCurrentValue(lookup, 'justify-content', JUSTIFY_GROUP);
      expect(result).toEqual({ raw: 'flex-start', label: 'Start' });
    });
  });

  describe('formatCurrentValue', () => {
    it('renders loading / not set honestly', () => {
      expect(formatCurrentValue('loading')).toBe('Current: loading…');
      expect(formatCurrentValue('unset')).toBe('Current: not set');
    });
    it('renders raw-only and labelled forms', () => {
      expect(formatCurrentValue({ raw: '36px', label: null })).toBe('Current: 36px');
      expect(formatCurrentValue({ raw: 'column', label: 'Column' })).toBe('Current: Column (column)');
    });
  });
});
