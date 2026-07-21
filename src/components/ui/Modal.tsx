import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
}

export function Modal({ open, onClose, title, children, width = "max-w-2xl" }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={overlayRef}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === overlayRef.current) onClose();
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            className={`flex flex-col w-full ${width} mx-5 rounded-[var(--radius-surface)] border shadow-2xl`}
            style={{
              backgroundColor: "rgba(26, 27, 25, 0.9)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              borderColor: "var(--color-neutral-border)",
              maxHeight: "min(840px, calc(100vh - 48px))",
            }}
          >
            <div
              className="flex items-center justify-between px-7 py-5 border-b rounded-t-[var(--radius-surface)]"
              style={{ borderColor: "var(--color-neutral-border)" }}
            >
              <h2 className="font-display font-bold text-lg text-neutral-text tracking-tight">
                {title}
              </h2>
              <button
                onClick={onClose}
                className="ui-icon-button hover:bg-white/5"
                title="Chiudi"
              >
                <X size={18} className="text-neutral-text-muted" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-7 py-6">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
