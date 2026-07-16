# Tickets: Terminal Title Bar

Aggiungere una barra del titolo full-width in cima a ogni terminale, con pallino colore workspace, nome sessione (agente + progetto), branch git, rename con doppio click, e pulsanti focus/close.

Fonte: `docs/specs/terminal-title-bar.md`

Lavora la **frontier**: qualsiasi ticket i cui blocker sono completati. Per una catena lineare pura procedi dall'alto verso il basso.

## ✅ 1. shared-workspace-colors (done)

## ✅ 2. backend-git-branch (done)

## ✅ 3. terminal-store-titles (done)

## ✅ 4. title-bar-ui (done)

## 5. [BUG] branch detection inaffidabile — apici PowerShell, CWD non si aggiorna

**What to build:** La title bar mostra il branch git in modo intermittente. Cause identificate:

1. **Apici PowerShell**: quando l'utente fa `cd '.\Traflix Portfolio\'` (con apici singoli per gestire spazi), il path arriva al backend con gli apici letterali. `canonicalize()` fallisce perché `'.\Traflix Portfolio\'` non è un path valido. Il CWD non viene mai aggiornato.
2. **Evento `terminal-cwd-changed` non testato**: il backend emette l'evento ma non è chiaro se il frontend lo riceve correttamente.
3. **Silenziosità**: `get_git_branch` fallisce silenziosamente (`.catch(() => {})`) e il branch rimane `null`.

Fixes già applicati in `ca2817d` / `24b4435` / `b063745`:
- Quote stripping in `resolve_and_update_cwd` (session.rs)
- Logging aggiunto: `tracing::info!` in `get_git_branch`, `update_cwd_from_input`, `resolve_and_update_cwd`
- Logging frontend: `console.log` per fetch mount, `terminal-cwd-changed` event, errori
- `cwd_changed` AtomicBool emette evento Tauri `terminal-cwd-changed`
- Frontend ascolta evento e rifetches branch

**Blocked by:** None (hotfix su feature già completata)

- [ ] Test con `cd '.\cartella con spazi\'` — branch si aggiorna
- [ ] Test con `cd ..` + `cd cartella` (due comandi separati) — branch aggiornato
- [ ] Test cambio workspace dopo `cd` — branch aggiornato al rientro
- [ ] Verificare log backend: log `terminal_cwd_detected` e `get_git_branch: success/failed`
- [ ] Verificare log frontend: `[branch] mount fetch for ...` e `[branch] cwd-changed event for ...`
