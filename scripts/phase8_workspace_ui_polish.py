from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing expected block: {label}")
    return text.replace(old, new, 1)


path = Path("src/components/workspace/WorkspaceView.tsx")
text = path.read_text(encoding="utf-8")

old_empty = '''  // Empty state — nessun workspace aperto
  if (!workspace && !activeWorkspaceId) {
    return (
      <>
        <div className="flex h-full items-center justify-center px-8 text-neutral-text-muted">
          <div className="panel flex max-w-xl flex-col items-center px-12 py-14 text-center shadow-2xl tab-slide-in">
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/25 transition-transform duration-200 hover:scale-105">
              <TerminalSquare size={32} strokeWidth={1.5} className="text-primary" />
            </div>
            <div>
            <h2 className="font-display font-extrabold text-2xl text-neutral-text mb-3 tracking-tight">
              Nessun Spazio Aperto
            </h2>
            <p className="text-[0.9375rem] text-neutral-text-dim max-w-md mb-8 leading-relaxed mx-auto">
              Seleziona un workspace dalla sidebar o creane uno nuovo per iniziare ad operare con i terminali ed agenti.
            </p>
             <button
               onClick={() => setWizardOpen(true)}
               className="inline-flex items-center gap-2 text-sm font-bold rounded-xl transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.97] hover:shadow-[0_0_20px_rgba(255,157,36,0.25)] cursor-pointer"
               style={{
                 padding: "10px 24px",
                 background: "linear-gradient(135deg, var(--color-primary), var(--color-primary-strong))",
                 color: "var(--color-neutral-bg)",
                 boxShadow: "0 4px 12px rgba(255, 157, 36, 0.18)",
               }}
             >
               <Plus size={18} strokeWidth={2.2} />
               Nuovo Spazio
             </button>
            </div>
          </div>
        </div>
        <NewSpaceWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
        />
      </>
    );
  }
'''
new_empty = '''  // Empty state — keep the desktop shell quiet and task-focused.
  if (!workspace && !activeWorkspaceId) {
    return (
      <>
        <div className="flex h-full items-center justify-center bg-neutral-darkest px-8">
          <div className="max-w-sm text-center tab-slide-in">
            <TerminalSquare size={24} strokeWidth={1.4} className="mx-auto text-neutral-text-muted" />
            <h2 className="mt-4 font-display text-base font-semibold tracking-[-0.02em] text-neutral-text">
              No workspace open
            </h2>
            <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-neutral-text-muted">
              Select a workspace from the sidebar or create one to start working.
            </p>
            <button type="button" onClick={() => setWizardOpen(true)} className="primary-button mt-5">
              <Plus size={14} /> New space
            </button>
          </div>
        </div>
        <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      </>
    );
  }
'''
text = replace_once(text, old_empty, new_empty, "workspace empty state")

old_header = '''        {/* Header del workspace attivo */}
        <div
          className="bg-black/5 backdrop-blur-sm"
          style={{
            padding: "16px 24px 14px",
            flexShrink: 0,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "16px",
            borderBottom: "1px solid var(--color-neutral-border)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: "18px",
                color: "var(--color-neutral-text)",
                letterSpacing: "-0.02em",
                lineHeight: 1.25,
              }}
            >
              {activeLoaded.name}
            </h1>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                color: "var(--color-neutral-text-muted)",
                marginTop: "4px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                lineHeight: 1.4,
              }}
            >
              {activeLoaded.rootPath}
            </p>
          </div>

        </div>
'''
new_header = '''        {/* Compact workspace identity bar. Terminal content gets the space. */}
        <div className="flex h-12 shrink-0 items-center border-b border-neutral-border bg-neutral-surface px-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-[13px] font-semibold tracking-[-0.02em] text-neutral-text">
              {activeLoaded.name}
            </h1>
            <p className="mt-0.5 truncate font-mono text-[9px] text-neutral-text-muted" title={activeLoaded.rootPath}>
              {activeLoaded.rootPath}
            </p>
          </div>
        </div>
'''
text = replace_once(text, old_header, new_header, "workspace header")

path.write_text(text, encoding="utf-8")
print("Workspace UI polish applied")
