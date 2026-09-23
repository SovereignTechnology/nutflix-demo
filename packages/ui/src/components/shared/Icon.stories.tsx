import type { Meta, StoryObj } from '@storybook/react-vite';
import { ICON_NAMES, Icon } from './Icon.js';

const meta = {
  title: 'Components/Icon',
  component: Icon,
  parameters: { nf: { width: 720 } },
} satisfies Meta<typeof Icon>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every icon in the set with its name (24 px, currentColor, aria-hidden). */
export const Gallery: Story = {
  args: { name: 'play' },
  render: () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
        gap: 16,
        fontSize: 12,
      }}
    >
      {ICON_NAMES.map((name) => (
        <div
          key={name}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
        >
          <Icon name={name} />
          <span>{name}</span>
        </div>
      ))}
    </div>
  ),
};
