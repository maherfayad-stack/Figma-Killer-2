import { describe, expect, it } from 'vitest';
import { buildButtonClassName } from './Button.js';
import { meta } from './meta.js';

describe('buildButtonClassName', () => {
  it('builds the default primary/default class list', () => {
    expect(buildButtonClassName('primary', 'default')).toBe('btn btn--primary btn--size-default');
  });

  it('appends a caller-supplied className', () => {
    expect(buildButtonClassName('secondary', 'small', 'mt-4')).toBe(
      'btn btn--secondary btn--size-small mt-4',
    );
  });

  it('omits a falsy className rather than leaving a trailing space', () => {
    expect(buildButtonClassName('destructive', 'medium', undefined)).toBe(
      'btn btn--destructive btn--size-medium',
    );
  });
});

describe('Button meta (ComponentsPanel input, P4)', () => {
  it('matches the {name, description, category, propsSchemaFrom} shape', () => {
    expect(meta).toEqual({
      name: 'Button',
      description: expect.any(String),
      category: 'actions',
      propsSchemaFrom: 'types',
    });
  });
});
