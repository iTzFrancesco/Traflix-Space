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
  success: "text-green-400 bg-green-500/10 border-green-500/20",
  error: "text-red-400 bg-red-500/10 border-red-500/20",
  info: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  warning: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
};

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
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
              className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm min-w-[300px] max-w-[420px] ${colorMap[toast.type]}`}
              style={{ backgroundColor: "rgba(17,17,19,0.95)" }}
            >
              <Icon size={18} className="shrink-0 mt-0.5" />
              <p className="flex-1 text-sm text-neutral-text">{toast.message}</p>
              <button
                onClick={() => removeToast(toast.id)}
                className="shrink-0 text-neutral-text-muted hover:text-neutral-text transition-colors"
              >
                <X size={14} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
