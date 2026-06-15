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

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

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
            className={`flex flex-col w-full ${width} mx-4 rounded-xl border shadow-2xl`}
            style={{
              backgroundColor: "#111113",
              borderColor: "rgba(255,255,255,0.06)",
              maxHeight: "85vh",
            }}
          >
            <div
              className="flex items-center justify-between px-5 py-4 border-b rounded-t-xl"
              style={{ borderColor: "rgba(255,255,255,0.06)" }}
            >
              <h2 className="font-display font-bold text-base text-neutral-text">
                {title}
              </h2>
              <button
                onClick={onClose}
                className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/5 transition-colors"
              >
                <X size={16} className="text-neutral-text-muted" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
