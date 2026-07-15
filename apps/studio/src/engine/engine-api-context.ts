import * as React from 'react';
import type { EngineApi } from './engine-api.js';
import { createMockEngineApi } from './mock-engine-api.js';

/**
 * React context for the FROZEN P4 engine API (ADR-0022). Defaults to the
 * mock implementation so every consumer (`ComponentsPanel`, `TokensPanel`,
 * `Inspector`'s Fill/component-props sections) works without a provider in
 * tests; `WorkspaceShell`/tests may override via `EngineApiContext.Provider`
 * value to inject a different (e.g. spy-wrapped) implementation.
 */
export const EngineApiContext = React.createContext<EngineApi>(createMockEngineApi());

export function useEngineApi(): EngineApi {
  return React.useContext(EngineApiContext);
}
