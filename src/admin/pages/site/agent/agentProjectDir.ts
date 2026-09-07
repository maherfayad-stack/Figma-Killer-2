/**
 * agentProjectDir — "which Studio project is this tab's agent working in",
 * answered in ONE place on the client.
 *
 * Since W10 the answer is load-bearing three times over, and all three have
 * to agree or the session silently misbehaves:
 *
 *   1. `POST /admin/api/ai/conversations` stamps the new thread's
 *      `project_key` from it.
 *   2. `POST /admin/api/ai/chat` sends it as `workspaceDir`; the server keys
 *      the turn by it and answers 409 if it disagrees with the thread's stamp.
 *   3. `GET /admin/api/ai/editor-bridge?dir=` registers this tab's browser
 *      bridge under `site:${projectKey}`. A bridge registered for a different
 *      project than the turn names is simply never found, and every browser
 *      tool call times out with "open the Site editor".
 *
 * It reads `useAdminUi`'s `studioProject`, which `fsCodemodAdapter.ts` sets
 * from the dir the server reported it actually LOADED — deliberately not
 * `studioWriteDir()`, whose localStorage override can name a project the
 * server did not honour (a stale selection for a deleted project, say). A
 * dir the server rejected is not this tab's project, and stamping a thread
 * with it would be a lie the very first turn would have to refuse.
 *
 * `null` before the first load completes: the composer cannot send yet
 * either, and the bridge simply retries.
 */
import { useAdminUi } from '@admin/state/adminUi'

export function agentProjectDir(): string | null {
  return useAdminUi.getState().studioProject?.dir ?? null
}
