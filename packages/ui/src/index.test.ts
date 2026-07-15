import { describe, expect, it } from 'vitest';
import * as UI from './index.js';

describe('@ccs/ui (P5)', () => {
  it('declares its owning phase', () => {
    expect(UI.UI_PACKAGE_PHASE).toBe('P5');
  });

  it('exports the full Penpot-grade primitive set (playbook §5 prompt: button, input, select, tree, panel, tabs, tooltip, context-menu, dropdown)', () => {
    expect(typeof UI.Button).toBe('object'); // forwardRef component
    expect(typeof UI.Input).toBe('object');
    expect(typeof UI.Select).toBe('object');
    expect(typeof UI.Checkbox).toBe('object');
    expect(typeof UI.Panel).toBe('function');
    expect(typeof UI.Tabs).toBe('function');
    expect(typeof UI.Tooltip).toBe('function');
    expect(typeof UI.ContextMenu).toBe('function');
    expect(typeof UI.DropdownMenu).toBe('function');
    expect(typeof UI.Tree).toBe('function');
    expect(typeof UI.flattenTree).toBe('function');
  });
});
