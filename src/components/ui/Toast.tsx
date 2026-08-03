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
    <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-3 pointer-events-none">
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
              className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-[var(--radius-surface)] border shadow-lg backdrop-blur-sm min-w-[320px] max-w-[440px] ${colorMap[toast.type]}`}
              style={{ backgroundColor: "rgba(26, 27, 25, 0.95)", borderColor: "var(--color-neutral-border)" }}
            >
              <Icon size={18} className="shrink-0 mt-0.5" />
              <p className="flex-1 text-sm text-neutral-text leading-relaxed">{toast.message}</p>
              {toast.action && (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick();
                    removeToast(toast.id);
                  }}
                  className="shrink-0 rounded px-2 py-1 text-xs font-semibold text-primary hover:bg-white/10"
                >
                  {toast.action.label}
                </button>
              )}
              <button
                onClick={() => removeToast(toast.id)}
                className="ui-icon-button h-9 w-9 shrink-0 text-neutral-text-muted hover:text-neutral-text"
                title="Chiudi"
                aria-label="Chiudi notifica"
              >
                <X size={15} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
