/**
 * `@core/studio-share` — the shared contract for share links (W5-2). Imported
 * by the server (`server/handlers/studio/share*.ts`), the public viewer entry
 * (`src/admin/shareViewer/`), and the editor's Share dialog. See
 * `shareWire.ts` for what each of those three is allowed to know.
 */
export * from './shareWire'
