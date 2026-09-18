import { createContext, useContext } from 'react'

/**
 * DesignSystemContext — carries app-wide presentation settings that several
 * components share: the target platform (ios | android) and text direction
 * (ltr | rtl). Wrap the app (or a subtree) in <DesignSystemProvider> to set
 * these once instead of passing `platform`/`dir` to every component.
 *
 * Resolution order for any component: explicit prop > nearest provider > default.
 * The default context below means a component used WITHOUT a provider behaves
 * exactly as it did before this context existed (platform "ios", dir "ltr").
 */
const DEFAULTS = { platform: 'ios', dir: 'ltr' }

const DesignSystemContext = createContext(DEFAULTS)

export const DesignSystemProvider = ({ platform, dir, children }) => {
  const value = {
    platform: platform ?? DEFAULTS.platform,
    dir: dir ?? DEFAULTS.dir,
  }
  return (
    <DesignSystemContext.Provider value={value}>
      {children}
    </DesignSystemContext.Provider>
  )
}

/**
 * Resolve the effective platform for a component.
 * Pass the component's own `platform` prop; it wins when defined, otherwise the
 * value falls back to the nearest provider, then to the "ios" default.
 */
export const usePlatform = (propPlatform) => {
  const ctx = useContext(DesignSystemContext)
  return propPlatform ?? ctx.platform
}

/**
 * Resolve the effective text direction for a component.
 * Same precedence as usePlatform: prop > provider > "ltr" default.
 */
export const useDir = (propDir) => {
  const ctx = useContext(DesignSystemContext)
  return propDir ?? ctx.dir
}
