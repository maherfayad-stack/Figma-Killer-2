import { createHash } from 'node:crypto';

/**
 * Cheap content-identity check for the P3 concurrent-IDE-edit guard
 * (playbook §4/P3 pitfall #3, ADR-0018 item 10): snapshot a file's hash
 * before computing an AST op against it, then re-check right before
 * writing — if they differ, something else (the user's editor, git, etc.)
 * wrote to the file in between and the daemon must never clobber it.
 */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
