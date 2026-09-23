/**
 * Like / dislike transitions (ADR 0007 b, contracts v4). Pure: the screen owns the adapter
 * call, this decides WHICH call a press means and what the counts become if it succeeds, so
 * Watch and Shorts cannot drift apart on the one rule that matters — a withdrawn like is an
 * `unreact` (NIP-09 deletion), never a `-`, because dislikes are public.
 */

/** The signed-in viewer's own reaction (`VideoStats.myReaction`). */
export type MyReaction = 'like' | 'dislike';

/** What the like / dislike buttons show. A count is `undefined` while unknown (stats failed). */
export interface ReactionState {
  readonly likes: number | undefined;
  readonly dislikes: number | undefined;
  readonly mine: MyReaction | undefined;
}

/** The one `NetworkAdapter` call a press maps to. */
export type ReactionCall =
  { readonly method: 'react'; readonly content: '+' | '-' } | { readonly method: 'unreact' };

export interface ReactionStep {
  readonly call: ReactionCall;
  /** Optimistic state to show while the call is in flight (roll back to the old one on failure). */
  readonly next: ReactionState;
}

function adjust(n: number | undefined, delta: number): number | undefined {
  return n === undefined ? undefined : Math.max(0, n + delta);
}

/**
 * - neutral → like: `react('+')`, likes + 1; neutral → dislike: `react('-')`, dislikes + 1
 * - like ↔ dislike: ONE `react` with the new content (clients count the newest reaction per
 *   pubkey), one count down and the other up
 * - pressing the active one again: `unreact()`, its count − 1
 */
export function reactionStep(state: ReactionState, pressed: MyReaction): ReactionStep {
  if (state.mine === pressed) {
    return {
      call: { method: 'unreact' },
      next: {
        likes: pressed === 'like' ? adjust(state.likes, -1) : state.likes,
        dislikes: pressed === 'dislike' ? adjust(state.dislikes, -1) : state.dislikes,
        mine: undefined,
      },
    };
  }
  return {
    call: { method: 'react', content: pressed === 'like' ? '+' : '-' },
    next: {
      likes: adjust(state.likes, (pressed === 'like' ? 1 : 0) - (state.mine === 'like' ? 1 : 0)),
      dislikes: adjust(
        state.dislikes,
        (pressed === 'dislike' ? 1 : 0) - (state.mine === 'dislike' ? 1 : 0),
      ),
      mine: pressed,
    },
  };
}

/**
 * The buttons' state from `VideoStats` (v4); `undefined` stats = counts unknown.
 * `signedIn: false` drops `myReaction` — a signed-out viewer has no reaction of their own.
 */
export function reactionStateOf(
  stats:
    | { readonly likes: number; readonly dislikes: number; readonly myReaction?: MyReaction }
    | undefined,
  signedIn: boolean,
): ReactionState {
  return {
    likes: stats?.likes,
    dislikes: stats?.dislikes,
    mine: signedIn ? stats?.myReaction : undefined,
  };
}
