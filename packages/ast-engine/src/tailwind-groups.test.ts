import { describe, expect, it } from 'vitest';
import { classGroupKey, mergeClassNames } from './tailwind-groups.js';

describe('classGroupKey', () => {
  it('groups background color utilities together, distinct from bg position/repeat', () => {
    expect(classGroupKey('bg-red-500')).toBe('bg-color');
    expect(classGroupKey('bg-blue-200')).toBe('bg-color');
    expect(classGroupKey('bg-center')).toBe('bg-center');
    expect(classGroupKey('bg-no-repeat')).toBe('bg-no-repeat');
  });

  it('keeps p/px/py/pt/pr/pb/pl as distinct flat groups (scope decision)', () => {
    expect(classGroupKey('p-4')).toBe('p');
    expect(classGroupKey('px-4')).toBe('px');
    expect(classGroupKey('py-4')).toBe('py');
    expect(classGroupKey('pt-4')).toBe('pt');
    expect(classGroupKey('pr-4')).toBe('pr');
    expect(classGroupKey('pb-4')).toBe('pb');
    expect(classGroupKey('pl-4')).toBe('pl');
    expect(classGroupKey('ps-4')).toBe('ps');
    expect(classGroupKey('pe-4')).toBe('pe');
  });

  it('does not confuse padding/margin prefixes with unrelated utilities', () => {
    expect(classGroupKey('pointer-events-none')).toBeNull();
    expect(classGroupKey('placeholder-red-500')).toBeNull();
    expect(classGroupKey('max-w-lg')).toBe('max-w');
    expect(classGroupKey('min-w-0')).toBe('min-w');
  });

  it('text: size, color, align, transform, decoration are distinct groups', () => {
    expect(classGroupKey('text-lg')).toBe('text-size');
    expect(classGroupKey('text-red-500')).toBe('text-color');
    expect(classGroupKey('text-center')).toBe('text-align');
    expect(classGroupKey('uppercase')).toBe('text-transform');
    expect(classGroupKey('underline')).toBe('text-decoration-line');
  });

  it('rounded: side-specific groups distinct from generic radius', () => {
    expect(classGroupKey('rounded-lg')).toBe('rounded');
    expect(classGroupKey('rounded-full')).toBe('rounded');
    expect(classGroupKey('rounded-t-lg')).toBe('rounded-t');
    expect(classGroupKey('rounded-tl-lg')).toBe('rounded-tl');
    expect(classGroupKey('rounded-tl')).toBe('rounded-tl');
  });

  it('border: width/color/style are distinct, side-specific width/color distinct from bare', () => {
    expect(classGroupKey('border')).toBe('border-width');
    expect(classGroupKey('border-2')).toBe('border-width');
    expect(classGroupKey('border-t')).toBe('border-t-width');
    expect(classGroupKey('border-t-4')).toBe('border-t-width');
    expect(classGroupKey('border-t-red-500')).toBe('border-t-color');
    expect(classGroupKey('border-red-500')).toBe('border-color');
    expect(classGroupKey('border-solid')).toBe('border-style');
  });

  it('flex/grid/gap groups', () => {
    expect(classGroupKey('flex')).toBe('display');
    expect(classGroupKey('flex-row')).toBe('flex-direction');
    expect(classGroupKey('flex-col')).toBe('flex-direction');
    expect(classGroupKey('flex-wrap')).toBe('flex-wrap');
    expect(classGroupKey('flex-1')).toBe('flex');
    expect(classGroupKey('flex-none')).toBe('flex');
    expect(classGroupKey('grid-cols-3')).toBe('grid-cols');
    expect(classGroupKey('gap-4')).toBe('gap');
    expect(classGroupKey('gap-x-2')).toBe('gap-x');
  });

  it('w/h and min/max variants', () => {
    expect(classGroupKey('w-full')).toBe('w');
    expect(classGroupKey('h-10')).toBe('h');
    expect(classGroupKey('min-h-screen')).toBe('min-h');
    expect(classGroupKey('max-h-full')).toBe('max-h');
  });

  it('variant prefixes scope groups independently', () => {
    expect(classGroupKey('hover:bg-red-500')).toBe('hover:bg-color');
    expect(classGroupKey('bg-red-500')).toBe('bg-color');
    expect(classGroupKey('md:hover:bg-red-500')).toBe('md:hover:bg-color');
  });

  it('untracked / arbitrary classes return null (never evict)', () => {
    expect(classGroupKey('my-custom-class')).toBeNull();
    expect(classGroupKey('data-[state=open]:animate-in')).toBeNull();
  });
});

describe('mergeClassNames', () => {
  it('adding bg-red-500 removes an existing bg-* color class', () => {
    expect(mergeClassNames('flex bg-blue-200 p-4', ['bg-red-500'], [])).toBe(
      'flex p-4 bg-red-500',
    );
  });

  it('does not remove bg-center when adding a bg color (different group)', () => {
    expect(mergeClassNames('bg-center bg-blue-200', ['bg-red-500'], [])).toBe(
      'bg-center bg-red-500',
    );
  });

  it('px-4 does not evict an existing p-2 (flat groups, documented scope decision)', () => {
    expect(mergeClassNames('p-2', ['px-4'], [])).toBe('p-2 px-4');
  });

  it('explicit remove list is applied before add-eviction', () => {
    expect(mergeClassNames('text-sm text-red-500', [], ['text-red-500'])).toBe('text-sm');
  });

  it('adding an exact-duplicate class is a no-op (no reordering, no dup)', () => {
    expect(mergeClassNames('flex p-4', ['flex'], [])).toBe('flex p-4');
  });

  it('last add wins when two adds share a group', () => {
    expect(mergeClassNames('', ['bg-red-500', 'bg-blue-500'], [])).toBe('bg-blue-500');
  });

  it('untracked classes are additive only, never evict', () => {
    expect(mergeClassNames('my-custom-class', ['another-custom'], [])).toBe(
      'my-custom-class another-custom',
    );
  });
});
