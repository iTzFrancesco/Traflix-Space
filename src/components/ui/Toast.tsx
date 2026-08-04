import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useToastStore, type ToastType } from "../../stores/toastStore";

const iconMap: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap: Record<ToastType, string> = {
  success: "text-signal bg-[var(--color-signal)]/10 border-[var(--color-signal)]/20",
  error: "text-danger bg-[var(--color-danger)]/10 border-[var(--color-danger)]/20",
  info: "text-primary bg-[var(--color-primary)]/10 border-[var(--color-primary)]/20",
  warning: "text-primary-light bg-[var(--color-primary-light)]/10 border-[var(--color-primary-light)]/20",
};

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  return (
    <div
      className="fixed bottom-7 z-[100] flex flex-col gap-4 pointer-events-none"
      style={{ right: "clamp(18px, 2vw, 32px)" }}
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => {
          const Icon = iconMap[toast.type];
          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 100, scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className={`pointer-events-auto flex items-center gap-4 px-6 py-5 rounded-[var(--radius-surface)] border shadow-2xl backdrop-blur-sm min-w-[460px] max-w-[640px] ${colorMap[toast.type]}`}
              style={{ backgroundColor: "rgba(26, 27, 25, 0.95)", borderColor: "var(--color-neutral-border)" }}
            >
              <Icon size={25} className="shrink-0" />
              <p className="flex-1 text-base leading-relaxed font-medium text-neutral-text">{toast.message}</p>
              {toast.action && (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick();
                    removeToast(toast.id);
                  }}
                  className="shrink-0 rounded-lg px-5 py-3 text-base font-bold text-primary border border-primary/30 hover:bg-primary/10"
                >
                  {toast.action.label}
                </button>
              )}
              <button
                onClick={() => removeToast(toast.id)}
                className="ui-icon-button flex h-9 w-9 shrink-0 items-center justify-center text-neutral-text-muted hover:text-neutral-text"
                title="Chiudi"
                aria-label="Chiudi notifica"
              >
                <X size={16} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
