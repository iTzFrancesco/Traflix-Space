import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useToastStore, type ToastType } from "../../stores/toastStore";

const iconMap: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap: Record<ToastType, string> = {
  success: "text-signal",
  error: "text-danger",
  info: "text-primary",
  warning: "text-warning",
};

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();
  const reduceMotion = useReducedMotion();

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(400px,calc(100vw-32px))] flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions text"
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => {
          const Icon = iconMap[toast.type];
          const urgent = toast.type === "error" || toast.type === "warning";
          return (
            <motion.div
              key={toast.id}
              layout={!reduceMotion}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 14 }}
              transition={{ duration: reduceMotion ? 0 : 0.14, ease: "easeOut" }}
              className="pointer-events-auto flex items-start gap-2.5 rounded-md border border-neutral-border bg-neutral-elevated px-3 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
              role={urgent ? "alert" : "status"}
            >
              <Icon
                size={16}
                className={`mt-0.5 shrink-0 ${colorMap[toast.type]}`}
                aria-hidden="true"
              />
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-text">
                {toast.message}
              </p>
              {toast.action && (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick();
                    removeToast(toast.id);
                  }}
                  className="shrink-0 rounded px-2 py-1 text-[10px] font-semibold text-primary hover:bg-primary/10"
                >
                  {toast.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="ui-icon-button h-6 w-6 shrink-0"
                title="Chiudi"
                aria-label="Chiudi notifica"
              >
                <X size={12} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
