import { X, Minus, LayoutGrid } from "lucide-react";
import { AgentBadge } from "./AgentBadge";

interface TerminalHeaderProps {
  title: string;
  agentId?: string | null;
  agentColor?: string;
  isActive: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
}

export function TerminalHeader({
  title,
  agentId,
  agentColor,
  isActive,
  onClose,
  onMinimize,
  onMaximize,
}: TerminalHeaderProps) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 select-none"
      style={{
        backgroundColor: "#18181b",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        borderTopLeftRadius: "12px",
        borderTopRightRadius: "12px",
      }}
    >
      <div className="flex items-center gap-1.5">
        <button
          onClick={onClose}
          className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-400 transition-colors flex items-center justify-center group"
          title="Close"
        >
          <X size={6} className="opacity-0 group-hover:opacity-100 text-red-900" />
        </button>
        <button
          onClick={onMinimize}
          className="w-3 h-3 rounded-full bg-yellow-500/80 hover:bg-yellow-400 transition-colors flex items-center justify-center group"
          title="Minimize"
        >
          <Minus size={6} className="opacity-0 group-hover:opacity-100 text-yellow-900" />
        </button>
        <button
          onClick={onMaximize}
          className="w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-400 transition-colors flex items-center justify-center group"
          title="Maximize"
        >
          <LayoutGrid size={6} className="opacity-0 group-hover:opacity-100 text-green-900" />
        </button>
      </div>

      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span
          className="text-xs font-mono truncate"
          style={{
            color: isActive ? "#f4f4f5" : "#71717a",
          }}
        >
          {title}
        </span>
      </div>

      {agentId && (
        <AgentBadge agentId={agentId} color={agentColor} />
      )}
    </div>
  );
}
