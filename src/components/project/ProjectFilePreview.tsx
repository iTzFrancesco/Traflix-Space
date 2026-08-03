import { FileText, LoaderCircle, X } from "lucide-react";
import type { ProjectFilePreview as ProjectFilePreviewData } from "../../project/types";

interface ProjectFilePreviewProps {
  preview: ProjectFilePreviewData | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectFilePreview({ preview, loading, error, onClose }: ProjectFilePreviewProps) {
  return (
    <section className="mx-2 flex h-[30%] max-h-[280px] min-h-[120px] min-w-0 max-w-[calc(100%-1rem)] shrink-0 flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-black/20">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <FileText size={14} className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.68rem] font-semibold text-neutral-text" title={preview?.path}>
            {preview?.path ?? "Anteprima file"}
          </p>
          <p className="mt-0.5 text-[0.56rem] uppercase tracking-wider text-neutral-text-muted">
            {preview ? `Preview read-only · ${formatSize(preview.size)}` : "Preview read-only"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ui-icon-button h-7 w-7 shrink-0"
          title="Chiudi preview"
          aria-label="Chiudi preview"
        >
          <X size={13} />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-text-muted">
          <LoaderCircle size={14} className="animate-spin text-primary" />
          Lettura file…
        </div>
      )}

      {!loading && error && <p className="px-3 py-4 text-xs text-red-200">{error}</p>}

      {!loading && !error && preview?.binary && (
        <p className="px-3 py-4 text-xs leading-relaxed text-neutral-text-muted">
          Questo file è binario e non può essere visualizzato in anteprima.
        </p>
      )}

      {!loading && !error && preview && !preview.binary && (
        <pre className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-auto overflow-y-auto whitespace-pre px-3 py-2 font-mono text-[0.58rem] leading-relaxed text-neutral-text-dim">
          {preview.content || "(file vuoto)"}
        </pre>
      )}

      {!loading && !error && preview?.truncated && (
        <p className="shrink-0 border-t border-amber-300/15 bg-amber-300/[0.05] px-3 py-2 text-[0.6rem] text-amber-100">
          Preview limitata ai primi 128 KB.
        </p>
      )}
    </section>
  );
}
