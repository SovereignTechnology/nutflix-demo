import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReactionButtons } from './ReactionButtons.js';

const meta = {
  title: 'Components/ReactionButtons',
  component: ReactionButtons,
  parameters: { nf: { width: 320 } },
} satisfies Meta<typeof ReactionButtons>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {
  args: { likes: 1284, dislikes: 37, onReact: () => undefined },
};

export const Liked: Story = {
  args: { ...Neutral.args, likes: 1285, mine: 'like' },
};

export const Disliked: Story = {
  args: { ...Neutral.args, dislikes: 38, mine: 'dislike' },
};

export const ZeroCounts: Story = {
  name: 'Zero counts (still shown)',
  args: { likes: 0, dislikes: 0, onReact: () => undefined },
};

export const CountsUnknown: Story = {
  name: 'Counts unknown (stats failed)',
  args: { likes: undefined, dislikes: undefined, onReact: () => undefined },
};

export const Busy: Story = {
  name: 'Reaction in flight',
  args: { ...Liked.args, busy: true },
};

export const Stacked: Story = {
  name: 'Stacked (Shorts rail)',
  parameters: { nf: { width: 180 } },
  args: { likes: 4021, dislikes: 12, mine: 'like', layout: 'stacked', onReact: () => undefined },
  render: (args) => (
    <div className="nf-story-col" style={{ width: 148, alignItems: 'stretch' }}>
      <ReactionButtons {...args} />
    </div>
  ),
};
