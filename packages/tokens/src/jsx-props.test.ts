import { describe, expect, it } from 'vitest';
import { extractDestructuredProps } from './jsx-props.js';

describe('extractDestructuredProps', () => {
  it('reads a plain `export function X({...})` component', () => {
    const source = `export function Badge({ variant = 'alert', count, max = 99, dir, className, children, ...props }) {
      return null
    }`;
    expect(extractDestructuredProps(source, 'Badge').sort()).toEqual(
      ['variant', 'count', 'max', 'dir', 'className', 'children'].sort(),
    );
  });

  it('reads a `const X = ({...}) => ...` arrow-function component', () => {
    const source = `export const Stepper = ({ value, min = 0, max, onChange, dir = 'ltr' }) => {
      return null
    }`;
    expect(extractDestructuredProps(source, 'Stepper').sort()).toEqual(
      ['value', 'min', 'max', 'onChange', 'dir'].sort(),
    );
  });

  it('reads a `forwardRef(function X({...}, ref) => ...)` component', () => {
    const source = `import { forwardRef } from 'react'
      export const Checkbox = forwardRef(function Checkbox({
        checked,
        disabled = false,
        error = false,
        skeleton = false,
        dir = 'ltr',
        id: idProp,
        onChange,
        className = '',
        'aria-label': ariaLabel,
        ...props
      }, ref) {
        return null
      })`;
    expect(extractDestructuredProps(source, 'Checkbox').sort()).toEqual(
      ['checked', 'disabled', 'error', 'skeleton', 'dir', 'id', 'onChange', 'className', 'aria-label'].sort(),
    );
  });

  it('returns an empty array when the component name is not found', () => {
    const source = `export function Other() { return null }`;
    expect(extractDestructuredProps(source, 'Missing')).toEqual([]);
  });
});
