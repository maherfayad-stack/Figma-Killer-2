/**
 * The user record to draw for a comment's author.
 *
 * A real picture only when the author IS the signed-in user, because that is
 * the only identity this client can resolve: `.studio/comments.json` stores a
 * denormalized author SNAPSHOT (`userId`, `displayName`, `kind`) and
 * deliberately no image URL or email hash. That file is committed to the user's
 * repository, and an email-derived Gravatar hash sitting in it is a disclosure
 * the feature does not need to make.
 *
 * Everyone else — and every agent — falls through to `UserAvatar`'s own
 * initials circle, which is why the fallback is spelled as a user with no image
 * rather than as a second initials implementation. Shared by the canvas pin and
 * the panel row so the same author cannot wear two different faces in the two
 * places that show the same thread.
 */
import type { CmsCurrentUser } from '@core/persistence'
import type { CommentAuthor } from '@core/studio-comments'

export type CommentAvatarUser = Pick<
  CmsCurrentUser,
  'avatarUrl' | 'gravatarHash' | 'displayName' | 'email'
>

export function commentAvatarUser(
  author: CommentAuthor | null | undefined,
  currentUser: CmsCurrentUser | null,
): CommentAvatarUser {
  if (author && currentUser && author.kind === 'user' && author.userId === currentUser.id) {
    return currentUser
  }
  // Empty strings, not nulls: `resolveAvatarUrl` treats a blank hash as "no
  // image" and `UserAvatar` falls through to its initials circle, which is
  // exactly the intent — no URL to guess at, so draw the name.
  return { avatarUrl: null, gravatarHash: '', displayName: author?.displayName ?? '?', email: '' }
}
