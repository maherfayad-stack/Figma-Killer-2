import type {
  ComponentPropSchema,
  ComponentSummary,
  EngineApi,
  Token,
  TokenModel,
  TokenRef,
} from './engine-api.js';

/**
 * `createMockEngineApi()` — the P5-side stand-in for the FROZEN P4 engine
 * API (ADR-0022), used until `packages/tokens`/`@ccs/design-system` lands.
 * Component names/props are modeled on the REAL Almosafer DS components
 * already sitting in `./design-system/src/components/{Badge,Button}.jsx`
 * (read-only reference — this package never imports from there, per the
 * P5 scope rules) so integration swaps in real data with the same shape
 * rather than fictional props.
 */
export function createMockEngineApi(): EngineApi {
  const tokenModel = buildMockTokenModel();
  const components = buildMockComponents();

  return {
    tokenModel,
    listComponents(): ComponentSummary[] {
      return components.map(({ name, category, description }) => ({ name, category, description }));
    },
    getPropSchema(name: string): ComponentPropSchema | null {
      return components.find((c) => c.name === name)?.propSchema ?? null;
    },
    tokensForProperty(cssProp: string): TokenRef[] {
      const group = GROUP_BY_CSS_PROP[cssProp] ?? null;
      const all = tokenModel.sets.flatMap((s) => s.tokens);
      const matches = group ? all.filter((t) => t.group === group) : all;
      // De-dupe by name: a token overridden in a later theme set (e.g.
      // `dark-overrides`) shares its NAME with the base-set entry
      // (playbook §2.4 sets+themes model — same token, different value per
      // theme), so naively flat-mapping every set produces two entries with
      // the same `name` -> a React duplicate-`key` warning in every
      // `<Select>` consumer (Inspector's Fill section). First occurrence
      // (the base/"core" set) wins here; this mock has no theme context to
      // resolve "the active value" more precisely than that.
      const seen = new Set<string>();
      const deduped = matches.filter((t) => {
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        return true;
      });
      return deduped.map((t) => ({ name: t.name, value: t.value }));
    },
  };
}

const GROUP_BY_CSS_PROP: Record<string, string> = {
  'background-color': 'color',
  color: 'color',
  'border-color': 'color',
  'border-radius': 'radius',
  'font-size': 'fontSize',
  padding: 'dimension',
  gap: 'dimension',
};

function buildMockTokenModel(): TokenModel {
  const coreTokens: Token[] = [
    { name: 'color.primary', value: '#0ea5e9', type: 'color', group: 'color' },
    { name: 'color.secondary', value: '#64748b', type: 'color', group: 'color' },
    { name: 'color.danger', value: '#dc2626', type: 'color', group: 'color' },
    { name: 'color.surface', value: '#ffffff', type: 'color', group: 'color' },
    { name: 'radius.sm', value: '4px', type: 'radius', group: 'radius' },
    { name: 'radius.md', value: '8px', type: 'radius', group: 'radius' },
    { name: 'radius.full', value: '9999px', type: 'radius', group: 'radius' },
    { name: 'fontSize.sm', value: '14px', type: 'fontSize', group: 'fontSize' },
    { name: 'fontSize.lg', value: '18px', type: 'fontSize', group: 'fontSize' },
    { name: 'space.md', value: '16px', type: 'dimension', group: 'dimension' },
  ];
  const darkTokens: Token[] = [
    { name: 'color.primary', value: '#38bdf8', type: 'color', group: 'color' },
    { name: 'color.surface', value: '#0f172a', type: 'color', group: 'color' },
  ];

  const sets = [
    { name: 'core', tokens: coreTokens },
    { name: 'dark-overrides', tokens: darkTokens },
  ];

  return {
    sets,
    themes: [
      { name: 'light', sets: ['core'] },
      { name: 'dark', sets: ['core', 'dark-overrides'] },
    ],
    resolve(tokenName: string): Token | null {
      for (const set of sets) {
        const found = set.tokens.find((t) => t.name === tokenName);
        if (found) return found;
      }
      return null;
    },
  };
}

interface MockComponent extends ComponentSummary {
  propSchema: ComponentPropSchema;
}

function buildMockComponents(): MockComponent[] {
  return [
    {
      name: 'Button',
      category: 'Actions',
      description: 'Primary call-to-action button (Almosafer DS shape).',
      propSchema: {
        props: {
          variant: {
            type: 'enum',
            enum: ['primary', 'secondary', 'skeleton', 'apple-pay'],
            default: 'primary',
            control: 'select',
            required: true,
          },
          size: {
            type: 'enum',
            enum: ['default', 'small'],
            default: 'default',
            control: 'select',
          },
          label: { type: 'string', default: 'Button', control: 'text', required: true },
        },
      },
    },
    {
      name: 'Badge',
      category: 'Feedback',
      description: 'Count/status pip, optionally anchored to children.',
      propSchema: {
        props: {
          variant: {
            type: 'enum',
            enum: ['alert', 'new'],
            default: 'alert',
            control: 'select',
            required: true,
          },
          count: { type: 'number', control: 'number' },
          max: { type: 'number', default: 99, control: 'number' },
        },
      },
    },
    {
      name: 'Card',
      category: 'Layout',
      description: 'Elevated content container.',
      propSchema: {
        props: {
          elevated: { type: 'boolean', default: true, control: 'checkbox' },
        },
      },
    },
  ];
}
