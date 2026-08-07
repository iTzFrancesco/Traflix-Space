import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

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
  const reduceMotion = useReducedMotion();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
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
          transition={{ duration: reduceMotion ? 0 : 0.12 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onMouseDown={(event) => {
            if (event.target === overlayRef.current) onClose();
          }}
        >
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, scale: 0.985, y: 5 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.985, y: 5 }}
            transition={{ duration: reduceMotion ? 0 : 0.14, ease: "easeOut" }}
            className={`mx-5 flex w-full ${width} flex-col overflow-hidden rounded-[var(--radius-surface)] border border-neutral-border bg-neutral-surface shadow-[0_18px_55px_rgba(0,0,0,0.42)]`}
            style={{ maxHeight: "min(820px, calc(100vh - 40px))" }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-border px-5">
              <h2 className="font-display text-[15px] font-semibold tracking-[-0.02em] text-neutral-text">{title}</h2>
              <button type="button" onClick={onClose} className="ui-icon-button h-8 w-8" title="Chiudi" aria-label="Chiudi">
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
