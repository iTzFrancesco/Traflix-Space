from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing expected block: {label}")
    return text.replace(old, new, 1)


path = Path("src/components/workspace/TerminalPane.tsx")
text = path.read_text(encoding="utf-8")

text = replace_once(text,
'''const ACTIVE_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid var(--color-primary)",
  overflow: "hidden",
  isolation: "isolate",
  boxShadow: "0 4px 20px rgba(255, 157, 36, 0.04)",
};''',
'''const ACTIVE_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid color-mix(in oklch, var(--color-primary) 38%, transparent)",
  overflow: "hidden",
  isolation: "isolate",
  boxShadow: "none",
};''', "active style")

text = replace_once(text,
'''const FOCUSED_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid var(--color-primary-strong)",
  overflow: "hidden",
  isolation: "isolate",
  boxShadow: "0 4px 20px rgba(255, 107, 33, 0.05)",
};''',
'''const FOCUSED_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "var(--color-neutral-bg)",
  borderRadius: "var(--radius-pane)",
  border: "1px solid color-mix(in oklch, var(--color-primary) 52%, transparent)",
  overflow: "hidden",
  isolation: "isolate",
  boxShadow: "none",
};''', "focused style")

text = replace_once(text,
'''const TITLE_BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "rgba(255, 255, 255, 0.015)",
  borderBottom: "1px solid var(--color-neutral-border)",
  userSelect: "none",
  overflow: "hidden",
};''',
'''const TITLE_BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "var(--color-neutral-surface)",
  borderBottom: "1px solid var(--color-neutral-border)",
  userSelect: "none",
  overflow: "hidden",
};''', "title style")

text = replace_once(text,
'''function getTitleBarMetrics(terminalCount: number) {
  if (terminalCount <= 1) {
    return { height: 42, padding: "0 14px", fontSize: 13, buttonSize: 32, iconSize: 16, dotSize: 10 };
  }
  if (terminalCount === 2) {
    return { height: 40, padding: "0 12px", fontSize: 12, buttonSize: 32, iconSize: 15, dotSize: 9 };
  }
  if (terminalCount <= 4) {
    return { height: 38, padding: "0 10px", fontSize: 12, buttonSize: 32, iconSize: 14, dotSize: 8 };
  }
  return { height: 36, padding: "0 9px", fontSize: 12, buttonSize: 30, iconSize: 14, dotSize: 7 };
}''',
'''function getTitleBarMetrics(terminalCount: number) {
  if (terminalCount <= 1) {
    return { height: 34, padding: "0 9px", fontSize: 12, buttonSize: 26, iconSize: 13, dotSize: 7 };
  }
  if (terminalCount === 2) {
    return { height: 32, padding: "0 8px", fontSize: 11, buttonSize: 25, iconSize: 12, dotSize: 6 };
  }
  if (terminalCount <= 4) {
    return { height: 30, padding: "0 7px", fontSize: 11, buttonSize: 24, iconSize: 12, dotSize: 6 };
  }
  return { height: 29, padding: "0 7px", fontSize: 10, buttonSize: 23, iconSize: 11, dotSize: 5 };
}''', "title metrics")

text = replace_once(text,
'''const TITLE_BAR_LEFT: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  minWidth: 0,
  flex: 1,
};''',
'''const TITLE_BAR_LEFT: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "7px",
  minWidth: 0,
  flex: 1,
};''', "title left")

text = replace_once(text,
'''const TITLE_BAR_NAME: React.CSSProperties = {
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  color: "rgba(255,255,255,0.8)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "text",
  lineHeight: 1,
  minWidth: 0,
  letterSpacing: "0.02em",
};''',
'''const TITLE_BAR_NAME: React.CSSProperties = {
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  color: "var(--color-neutral-text-dim)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "text",
  lineHeight: 1,
  minWidth: 0,
  letterSpacing: 0,
};''', "title name")

text = replace_once(text,
'''const TOOL_BTN_BASE: React.CSSProperties = {
  width: "30px",
  height: "30px",
  borderRadius: "8px",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1,
  transition: "background 0.15s ease, color 0.15s ease",
  padding: 0,
};''',
'''const TOOL_BTN_BASE: React.CSSProperties = {
  width: "26px",
  height: "26px",
  borderRadius: "5px",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1,
  transition: "background-color 120ms ease, color 120ms ease",
  padding: 0,
};''', "tool buttons")

text = text.replace('''        boxShadow:\n          "inset 0 0 0 1px var(--color-primary), 0 0 16px rgba(232,93,4,0.15)",''', '''        boxShadow: "inset 0 0 0 1px var(--color-primary)",''')
text = text.replace('''            backdropFilter: isDragHovered ? "blur(4px)" : "none",\n            transition: "all 0.2s ease-in-out",''', '''            backdropFilter: "none",\n            transition: "background-color 120ms ease, border-color 120ms ease",''')
text = text.replace('''                textShadow: "0 0 10px rgba(232, 93, 4, 0.4)",''', '''                textShadow: "none",''')
text = text.replace('''              width: "48px",\n              height: "24px",\n              borderRadius: "6px",''', '''              width: "38px",\n              height: "20px",\n              borderRadius: "4px",''')
text = text.replace('''              e.currentTarget.style.boxShadow = "0 0 10px rgba(232,93,4,0.2)";''', '''              e.currentTarget.style.boxShadow = "none";''')
text = text.replace('''                  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",''', '''                  boxShadow: "none",''')
text = text.replace('''            borderRadius: "10px",''', '''            borderRadius: "5px",''', 1)
text = text.replace('''            backdropFilter: "blur(8px)",''', '''            backdropFilter: "none",''', 1)
text = text.replace('''              boxShadow: "0 0 8px currentColor",''', '''              boxShadow: "none",''', 1)
text = text.replace('''            backdropFilter: "blur(8px)",''', '''            backdropFilter: "none",''', 1)

# Keep semantic focus/close feedback, but drop the always-colored pill look.
text = text.replace('''                background: isFocused
                  ? "rgba(59,130,246,0.25)"
                  : "rgba(255,255,255,0.08)",
                color: isFocused ? "#60a5fa" : "#a1a1aa",''', '''                background: isFocused ? "rgba(233,138,45,0.10)" : "transparent",
                color: isFocused ? "var(--color-primary)" : "var(--color-neutral-text-muted)",''')
text = text.replace('''                e.currentTarget.style.background = isFocused
                  ? "rgba(59,130,246,0.4)"
                  : "rgba(255,255,255,0.14)";
                e.currentTarget.style.color = isFocused ? "#93c5fd" : "#f4f4f5";''', '''                e.currentTarget.style.background = isFocused ? "rgba(233,138,45,0.14)" : "rgba(255,255,255,0.06)";
                e.currentTarget.style.color = isFocused ? "var(--color-primary-light)" : "var(--color-neutral-text)";''')
text = text.replace('''                e.currentTarget.style.background = isFocused
                  ? "rgba(59,130,246,0.25)"
                  : "rgba(255,255,255,0.08)";
                e.currentTarget.style.color = isFocused ? "#60a5fa" : "#a1a1aa";''', '''                e.currentTarget.style.background = isFocused ? "rgba(233,138,45,0.10)" : "transparent";
                e.currentTarget.style.color = isFocused ? "var(--color-primary)" : "var(--color-neutral-text-muted)";''')
text = text.replace('''                  background: "rgba(239,68,68,0.2)",
                  color: "#ef4444",''', '''                  background: "transparent",
                  color: "var(--color-neutral-text-muted)",''')
text = text.replace('''                  e.currentTarget.style.background = "rgba(239,68,68,0.35)";''', '''                  e.currentTarget.style.background = "rgba(255,98,107,0.10)";
                  e.currentTarget.style.color = "var(--color-danger)";''')
text = text.replace('''                  e.currentTarget.style.background = "rgba(239,68,68,0.2)";''', '''                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--color-neutral-text-muted)";''')

path.write_text(text, encoding="utf-8")
print("TerminalPane UI polish applied")
