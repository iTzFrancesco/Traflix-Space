import { Sparkles } from "lucide-react";

export function JarvisOrb({ active = false }: { active?: boolean }) {
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
      style={{
        borderColor: active ? "rgba(255,157,36,0.7)" : "rgba(255,255,255,0.16)",
        backgroundColor: active ? "rgba(255,157,36,0.16)" : "rgba(255,255,255,0.05)",
        color: active ? "var(--color-primary)" : "var(--color-neutral-text-muted)",
      }}
      aria-hidden="true"
    >
      <Sparkles size={17} />
    </span>
  );
}
