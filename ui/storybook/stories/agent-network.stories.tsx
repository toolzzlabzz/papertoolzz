import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentNetworkPanel } from "@/components/AgentNetworkPanel";

const companyId = "company-storybook";

function StoryShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story">
      <div className="paperclip-story__inner max-w-5xl space-y-4 p-6">{children}</div>
    </div>
  );
}

const meta = {
  title: "Control Plane Surfaces/Agent Network Panel",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const LiveNetwork: Story = {
  render: () => (
    <StoryShell>
      <AgentNetworkPanel companyId={companyId} />
    </StoryShell>
  ),
};
