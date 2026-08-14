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

function previewKind(
  preview: ProjectFilePreviewData | null,
): "text" | "image" | "binary" | null {
  if (!preview) return null;
  if (preview.kind) return preview.kind;
  return preview.binary ? "binary" : "text";
}

export function ProjectFilePreview({
  preview,
  loading,
  error,
  onClose,
}: ProjectFilePreviewProps) {
  const kind = previewKind(preview);

  return (
    <section className="mx-2 flex h-[34%] max-h-[340px] min-h-[150px] min-w-0 max-w-[calc(100%-1rem)] shrink-0 flex-col overflow-hidden border border-neutral-border bg-neutral-darkest">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-border px-2.5">
        <FileText size={13} className="shrink-0 text-primary" />
        <p
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-neutral-text"
          title={preview?.path}
        >
          {preview?.path ?? "File preview"}
        </p>
        <span className="shrink-0 text-[9px] text-neutral-text-muted">
          {preview ? formatSize(preview.size) : "read only"}
        </span>
        {loading && (
          <LoaderCircle size={12} className="status-icon--spin text-primary" />
        )}
        <button
          type="button"
          onClick={onClose}
          className="ui-icon-button h-7 w-7 shrink-0"
          title="Close preview"
          aria-label="Close preview"
        >
          <X size={12} />
        </button>
      </div>

      {loading && !preview && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-text-muted">
          <LoaderCircle size={13} className="status-icon--spin text-primary" />
          Reading file…
        </div>
      )}

      {!loading && error && (
        <p className="px-3 py-4 text-xs text-danger">{error}</p>
      )}

      {!error &&
        preview &&
        kind === "image" &&
        preview.contentBase64 &&
        preview.mimeType && (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/20 p-2">
            <img
              src={`data:${preview.mimeType};base64,${preview.contentBase64}`}
              alt={preview.path}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}

      {!error && kind === "binary" && (
        <p className="px-3 py-4 text-xs leading-relaxed text-neutral-text-muted">
          Binary file — preview unavailable.
        </p>
      )}

      {!error && preview && kind === "text" && (
        <pre className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-auto overflow-y-auto whitespace-pre px-2.5 py-2 font-mono text-[10px] leading-relaxed text-neutral-text-dim">
          {preview.content || "(empty file)"}
        </pre>
      )}

      {!error && preview?.redacted && (
        <p className="shrink-0 border-t border-warning/20 px-2.5 py-1.5 text-[9px] text-warning">
          Anteprima protetta: i valori sensibili sono oscurati.
        </p>
      )}

      {!error && preview?.truncated && (
        <p className="shrink-0 border-t border-warning/20 px-2.5 py-1.5 text-[9px] text-warning">
          Preview truncated to keep the panel responsive.
        </p>
      )}
    </section>
  );
}
