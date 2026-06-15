import { Bot } from "lucide-react";
import { AGENTS } from "../../lib/agents";

interface AgentBadgeProps {
  agentId: string;
  color?: string;
}

export function AgentBadge({ agentId, color }: AgentBadgeProps) {
  const agent = AGENTS.find((a) => a.id === agentId);
  const badgeColor = color || agent?.color || "#71717a";
  const agentName = agent?.name || agentId;

  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.65rem] font-medium whitespace-nowrap shrink-0"
      style={{
        backgroundColor: `${badgeColor}18`,
        color: badgeColor,
        border: `1px solid ${badgeColor}30`,
      }}
    >
      <Bot size={10} />
      {agentName}
    </span>
  );
}
