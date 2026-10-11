/**
 * useStudioTokenCatalogSync - keeps the editor's token catalog current: it is
 * re-read whenever the load's authored or vendor CSS changes, which is exactly
 * when the set of declared variables (and the mode gates they sit under) can
 * differ.
 *
 * Two surfaces need the catalog and neither may depend on the other being
 * open: the Properties panel's variable pickers and the board's frame mode
 * chips. Both call this hook; `refreshStudioTokenCatalog` coalesces the calls a
 * single CSS change makes in the same commit into one request.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { refreshStudioTokenCatalog } from './studioTokenCatalog'
import { getStudioAuthoredCss, getStudioVendorCss, subscribeStudioAuthoredCss, subscribeStudioVendorCss } from './studioRawCssStores'

export function useStudioTokenCatalogSync(): void {
  const authoredCss = useSyncExternalStore(subscribeStudioAuthoredCss, getStudioAuthoredCss)
  const vendorCss = useSyncExternalStore(subscribeStudioVendorCss, getStudioVendorCss)

  useEffect(() => {
    void refreshStudioTokenCatalog()
  }, [authoredCss, vendorCss])
}
