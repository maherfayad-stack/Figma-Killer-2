/**
 * `EolPreservingFileSystem` — the single seam where a user's `\r\n` is taken
 * off on the way in and put back on the way out.
 *
 * WHY A FILE SYSTEM AND NOT A HELPER AT EVERY CALL SITE
 * -----------------------------------------------------
 * Studio opens other people's repositories, which on Windows are usually
 * CRLF. Two different failures follow from that, and one mechanism fixes
 * both:
 *
 *  1. **Writes.** Every structural and style codemod builds its inserted
 *     text with `'\n'` — the indent helpers in `jsxChildPlacement.ts`, the
 *     printed subtree in `jsxSubtree.ts`, postcss's `raws.before`, ts-morph's
 *     own `newLineKind`. Chasing each of those string literals would be a
 *     dozen band-aids that the next codemod re-breaks. Normalising the text
 *     ts-morph ever sees to `\n`, and re-applying the file's own ending at
 *     the moment bytes hit the disk, fixes every codemod at once and fixes
 *     the ones not written yet.
 *
 *  2. **Reads.** With the `\r`s gone before the parse, a CRLF checkout and
 *     an LF checkout of the same repository produce byte-identical node
 *     text, so a page tree — ids, `line:col`, resolved values — cannot
 *     depend on which way the user's Git happened to check the repo out.
 *
 * POSITIONS ARE NOT AFFECTED EITHER WAY
 * -------------------------------------
 * This is worth stating because it is the thing that would make the whole
 * design unsafe if it were false. TypeScript's `getLineStarts()` already
 * treats `\r\n` as one terminator, and the `\r` sits AFTER every token on
 * its line, so a node's 1-based `(line, col)` — the node-id grammar in
 * `docs/agent-refs/studio-pipeline.md` — is identical in the CRLF and LF
 * forms of a file. Normalising changes absolute offsets, never `line:col`.
 * Ids stay stable, and an id read from a CRLF parse still resolves in the
 * normalised text a codemod edits.
 *
 * WHAT IS DELIBERATELY NOT PRESERVED
 * ----------------------------------
 *  - A file with MIXED endings is rewritten to its dominant one (see
 *    `detectLineEnding`). We cannot promise per-line preservation without
 *    tracking every line through an AST rewrite, and a half-converted file
 *    is a defect to repair, not a style to protect.
 *  - Consequently, a multi-line template literal or JSX text block inside a
 *    mixed file has its embedded endings normalised with everything else.
 *    In a uniform file — the overwhelmingly common case — it round-trips
 *    byte-for-byte.
 *  - The byte-order mark is NOT this class's business: ts-morph strips it on
 *    read and re-adds it to the text it hands `writeFileSync`, and
 *    {@link applyLineEnding} leaves a leading `\uFEFF` alone.
 *
 * It lives beside `createWorkspaceProject` (`componentSources.ts`) because
 * that is the one function that decides how Studio opens a ts-morph
 * `Project`, and `@core/ast-codemods` already imports this barrel.
 */
import { Project, type FileSystemHost, type RuntimeDirEntry } from 'ts-morph'
import { applyLineEnding, detectLineEnding, toLf, LF, type LineEnding } from '@core/utils/lineEndings'
import { writeFileAtomic } from './atomicFileWrite'

/**
 * ts-morph does not export `RealFileSystemHost`, so the only supported way to
 * get one is to ask a throwaway disk-backed `Project` for it. Built lazily and
 * once: the constructor adds no files and reads no tsconfig.
 */
let realFileSystem: FileSystemHost | undefined
function getRealFileSystem(): FileSystemHost {
  realFileSystem ??= new Project({ useInMemoryFileSystem: false }).getFileSystem()
  return realFileSystem
}

/**
 * A `FileSystemHost` that hands ts-morph LF-only text and writes each file
 * back with the ending it was read with.
 *
 * Every method that is not a read or a write delegates verbatim — globbing,
 * directory listing and `realpath` semantics have to stay exactly ts-morph's
 * own, because `addSourceFilesAtPaths` depends on them.
 */
export class EolPreservingFileSystem implements FileSystemHost {
  readonly #inner: FileSystemHost
  readonly #endings = new Map<string, LineEnding>()
  /** True for the real disk (no `inner` given): writes then go through `writeFileAtomic`. */
  readonly #writesToDisk: boolean

  constructor(inner?: FileSystemHost) {
    this.#inner = inner ?? getRealFileSystem()
    this.#writesToDisk = inner === undefined
  }

  #key(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/')
    return this.#inner.isCaseSensitive() ? normalized : normalized.toLowerCase()
  }

  #record(filePath: string, raw: string): string {
    this.#endings.set(this.#key(filePath), detectLineEnding(raw))
    return toLf(raw)
  }

  /** The ending `filePath` was read with, or `'\n'` for a file this process has never read. */
  lineEndingFor(filePath: string): LineEnding {
    return this.#endings.get(this.#key(filePath)) ?? LF
  }

  /**
   * Declare the ending a file that does not exist on disk yet should be
   * written with. `extractSubtreeToComponent` and friends synthesise a new
   * component file next to the page they lifted it out of; without this it
   * would land as LF in an otherwise CRLF repository.
   */
  setLineEnding(filePath: string, eol: LineEnding): void {
    this.#endings.set(this.#key(filePath), eol)
  }

  /** Give `toFilePath` the ending recorded for `fromFilePath`. */
  inheritLineEnding(fromFilePath: string, toFilePath: string): void {
    this.setLineEnding(toFilePath, this.lineEndingFor(fromFilePath))
  }

  readFileSync(filePath: string, encoding?: string): string {
    return this.#record(filePath, this.#inner.readFileSync(filePath, encoding))
  }

  async readFile(filePath: string, encoding?: string): Promise<string> {
    return this.#record(filePath, await this.#inner.readFile(filePath, encoding))
  }

  /**
   * On the real disk, the file is replaced in one step (`writeFileAtomic`):
   * every codemod's `saveSync` lands here, and a crash, an OOM kill or the
   * P1-D watcher reading mid-write must never see half a page. ts-morph has
   * already made the parent directory by the time this runs.
   */
  writeFileSync(filePath: string, fileText: string): void {
    const text = applyLineEnding(fileText, this.lineEndingFor(filePath))
    if (this.#writesToDisk) writeFileAtomic(filePath, text)
    else this.#inner.writeFileSync(filePath, text)
  }

  async writeFile(filePath: string, fileText: string): Promise<void> {
    if (this.#writesToDisk) {
      this.writeFileSync(filePath, fileText)
      return
    }
    await this.#inner.writeFile(filePath, applyLineEnding(fileText, this.lineEndingFor(filePath)))
  }

  isCaseSensitive(): boolean {
    return this.#inner.isCaseSensitive()
  }

  delete(path: string): Promise<void> {
    return this.#inner.delete(path)
  }

  deleteSync(path: string): void {
    this.#inner.deleteSync(path)
  }

  readDirSync(dirPath: string): RuntimeDirEntry[] {
    return this.#inner.readDirSync(dirPath)
  }

  mkdir(dirPath: string): Promise<void> {
    return this.#inner.mkdir(dirPath)
  }

  mkdirSync(dirPath: string): void {
    this.#inner.mkdirSync(dirPath)
  }

  move(srcPath: string, destPath: string): Promise<void> {
    return this.#inner.move(srcPath, destPath)
  }

  moveSync(srcPath: string, destPath: string): void {
    this.#inner.moveSync(srcPath, destPath)
  }

  copy(srcPath: string, destPath: string): Promise<void> {
    return this.#inner.copy(srcPath, destPath)
  }

  copySync(srcPath: string, destPath: string): void {
    this.#inner.copySync(srcPath, destPath)
  }

  fileExists(filePath: string): Promise<boolean> {
    return this.#inner.fileExists(filePath)
  }

  fileExistsSync(filePath: string): boolean {
    return this.#inner.fileExistsSync(filePath)
  }

  directoryExists(dirPath: string): Promise<boolean> {
    return this.#inner.directoryExists(dirPath)
  }

  directoryExistsSync(dirPath: string): boolean {
    return this.#inner.directoryExistsSync(dirPath)
  }

  realpathSync(path: string): string {
    return this.#inner.realpathSync(path)
  }

  getCurrentDirectory(): string {
    return this.#inner.getCurrentDirectory()
  }

  glob(patterns: ReadonlyArray<string>): Promise<string[]> {
    return this.#inner.glob(patterns)
  }

  globSync(patterns: ReadonlyArray<string>): string[] {
    return this.#inner.globSync(patterns)
  }
}

/**
 * The `EolPreservingFileSystem` behind `project`, or `undefined` for a
 * `Project` built some other way (an in-memory one in a unit test, say).
 * Callers that only want to record an ending for a file they are about to
 * synthesise use this and no-op when it is absent.
 */
export function eolFileSystemOf(project: Project): EolPreservingFileSystem | undefined {
  const fileSystem = project.getFileSystem()
  return fileSystem instanceof EolPreservingFileSystem ? fileSystem : undefined
}

/** The ending `project` read `filePath` with — `'\n'` when the project does not track endings. */
export function projectLineEnding(project: Project, filePath: string): LineEnding {
  return eolFileSystemOf(project)?.lineEndingFor(filePath) ?? LF
}
