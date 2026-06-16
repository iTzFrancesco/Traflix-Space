import { Modal } from "../ui/Modal";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Impostazioni" width="max-w-lg">
      <div className="space-y-6">
        <p className="text-sm text-neutral-text-muted">
          Nessuna impostazione al momento.
        </p>
      </div>
    </Modal>
  );
}
