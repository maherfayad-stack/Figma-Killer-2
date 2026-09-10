import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ClassStyleInjector } from '@site/canvas/ClassStyleInjector'
import { CanvasFrameAdapterContext } from '@site/canvas/CanvasContexts'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { useEditorStore } from '@site/store/store'
import { classKindSelector, DEFAULT_BREAKPOINTS, type StyleRule } from '@core/page-tree'
import { refreshCmsMediaAssetCache } from '@admin/shared/media/hooks/useCmsMediaAssetByPath'
import { makeSite } from '../fixtures'

const originalFetch = globalThis.fetch

const backgroundPath = '/uploads/background.png'
const variantPath = '/uploads/background-w1024.webp'

function makeBackgroundClass(): StyleRule {
  return {
    id: 'hero-bg',
    name: 'hero-bg',
    kind: 'class',
    selector: classKindSelector('hero-bg'),
    order: 0,
    styles: {
      backgroundImage: `url('${backgroundPath}')`,
      backgroundSize: 'cover',
    },
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

function mediaResponse(): Response {
  return new Response(JSON.stringify({
    assets: [{
      id: 'asset-1',
      filename: 'background.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      publicPath: backgroundPath,
      uploadedByUserId: null,
      createdAt: '2026-07-03T00:00:00.000Z',
      width: 1024,
      height: 512,
      variants: [{
        width: 1024,
        height: 512,
        format: 'webp',
        path: variantPath,
        sizeBytes: 80,
      }],
    }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function resetEditorStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    previewClassStyles: null,
    activeClassId: null,
    selectedNodeId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('ClassStyleInjector media backgrounds', () => {
  let adapter: PortalFrameAdapter | null = null

  beforeEach(() => {
    cleanup()
    document.head.replaceChildren()
    document.body.replaceChildren()
    refreshCmsMediaAssetCache()
    resetEditorStore()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/admin/api/cms/media')) return mediaResponse()
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    cleanup()
    adapter?.dispose()
    adapter = null
    document.head.replaceChildren()
    document.body.replaceChildren()
    refreshCmsMediaAssetCache()
    resetEditorStore()
    globalThis.fetch = originalFetch
  })

  it('rewrites persisted class background images after the site loads during editor reload', async () => {
    adapter = new PortalFrameAdapter(document)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <ClassStyleInjector />
      </CanvasFrameAdapterContext.Provider>,
    )

    await act(async () => {
      useEditorStore.setState({
        site: {
          ...makeSite({ pages: [] }),
          breakpoints: DEFAULT_BREAKPOINTS,
          styleRules: {
            'hero-bg': makeBackgroundClass(),
          },
        },
      } as Parameters<typeof useEditorStore.setState>[0])
    })

    await waitFor(() => {
      const css = document.head.querySelector<HTMLStyleElement>('[data-studio-overlay-id="mc-classes"]')?.textContent ?? ''
      expect(css).toContain(`background-image: url("${variantPath}");`)
      expect(css).toContain('background-image: image-set(')
      expect(css).not.toContain(backgroundPath)
    })
  })
})
