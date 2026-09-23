import type { ReactElement } from 'react';
import { Button } from '../Button/Button.js';
import { cx, formatInteger } from '../shared/format.js';
import type { MyReaction } from './reaction.js';

export interface ReactionButtonsProps {
  /** Like count (`VideoStats.likes`); `undefined` = unknown, the button shows no number. */
  readonly likes: number | undefined;
  /** Dislike count (`VideoStats.dislikes`) — always shown next to likes (ADR 0007 b). */
  readonly dislikes: number | undefined;
  /** The viewer's own reaction (`VideoStats.myReaction`): that button renders pressed. */
  readonly mine?: MyReaction | undefined;
  /**
   * Called with the button pressed. The screen maps it to the adapter with `reactionStep`
   * (pressing the active one again means `unreact`, never `react('-')`).
   */
  readonly onReact: (pressed: MyReaction) => void;
  /** A reaction is in flight: presses are ignored (buttons stay focusable, `aria-busy`). */
  readonly busy?: boolean;
  /** `segmented` = one split pill (Watch, YouTube); `stacked` = two pills in a column (Shorts rail). */
  readonly layout?: 'segmented' | 'stacked';
  readonly className?: string;
}

function countLabel(n: number | undefined, one: string, many: string): string {
  return n === undefined ? '' : `, ${formatInteger(n)} ${n === 1 ? one : many}`;
}

/**
 * Like and dislike buttons with both counts, thumbs-up / thumbs-down icons and
 * `aria-pressed` from the viewer's own reaction. Presentational: props in, `onReact` out.
 */
export function ReactionButtons({
  likes,
  dislikes,
  mine,
  onReact,
  busy = false,
  layout = 'segmented',
  className,
}: ReactionButtonsProps): ReactElement {
  const press = (r: MyReaction): void => {
    if (!busy) onReact(r);
  };
  return (
    <div
      className={cx('nf-reactions', `nf-reactions--${layout}`, className)}
      role="group"
      aria-label="Like or dislike"
      aria-busy={busy || undefined}
    >
      <Button
        variant="secondary"
        icon="thumbUp"
        pressed={mine === 'like'}
        className="nf-reactions__like"
        aria-label={`Like${countLabel(likes, 'like', 'likes')}`}
        title={mine === 'like' ? 'Remove your like' : 'I like this'}
        onClick={() => {
          press('like');
        }}
      >
        {likes === undefined ? null : formatInteger(likes)}
      </Button>
      <Button
        variant="secondary"
        icon="thumbDown"
        pressed={mine === 'dislike'}
        className="nf-reactions__dislike"
        aria-label={`Dislike${countLabel(dislikes, 'dislike', 'dislikes')}`}
        title={mine === 'dislike' ? 'Remove your dislike' : 'I dislike this'}
        onClick={() => {
          press('dislike');
        }}
      >
        {dislikes === undefined ? null : formatInteger(dislikes)}
      </Button>
    </div>
  );
}
