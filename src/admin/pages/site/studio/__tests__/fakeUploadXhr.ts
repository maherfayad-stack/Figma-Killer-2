/**
 * Test-only stand-in for the browser's `XMLHttpRequest`, shaped to what
 * `@core/http`'s `apiUploadRequest` (the one XHR upload client) uses: `open`,
 * `setRequestHeader`, `upload.onprogress`, `send(FormData)`, and a text
 * response read back through `getResponseHeader`.
 *
 * Every request is recorded; the answer comes from `answer(url)`, and a
 * request can report progress before it resolves (`progress`), so a test can
 * watch a ghost fill as the bytes "go up".
 */

export interface FakeUploadRequest {
  url: string
  body: FormData
  headers: Record<string, string>
}

export interface FakeUploadAnswer {
  status: number
  body: unknown
  /** Fractions reported through `upload.onprogress` before the answer arrives. */
  progress?: readonly number[]
  /** Hold the answer until this promise resolves — lets a test observe the in-flight state. */
  gate?: Promise<void>
}

export interface FakeUploadXhr {
  requests: FakeUploadRequest[]
  install(): void
  restore(): void
}

export function createFakeUploadXhr(answer: (url: string, body: FormData) => FakeUploadAnswer): FakeUploadXhr {
  const requests: FakeUploadRequest[] = []
  const saved = globalThis.XMLHttpRequest

  class FakeXhr {
    status = 0
    response: unknown = ''
    responseText = ''
    responseType = ''
    withCredentials = false
    upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
      onprogress: null,
    }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    private url = ''
    private headers: Record<string, string> = {}
    open(_method: string, url: string) {
      this.url = url
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value
    }
    getResponseHeader(name: string) {
      return name.toLowerCase() === 'content-type' ? 'application/json' : null
    }
    abort() {
      queueMicrotask(() => this.onabort?.())
    }
    send(body: FormData) {
      requests.push({ url: this.url, body, headers: { ...this.headers } })
      const reply = answer(this.url, body)
      void (async () => {
        await Promise.resolve()
        for (const fraction of reply.progress ?? []) {
          this.upload.onprogress?.({ lengthComputable: true, loaded: fraction * 100, total: 100 })
        }
        if (reply.gate) await reply.gate
        this.status = reply.status
        this.responseText = reply.body === undefined ? '' : JSON.stringify(reply.body)
        this.response = this.responseText
        this.onload?.()
      })()
    }
  }

  return {
    requests,
    install: () => {
      globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
    },
    restore: () => {
      globalThis.XMLHttpRequest = saved
    },
  }
}
