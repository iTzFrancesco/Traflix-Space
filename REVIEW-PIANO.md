# Review totale del piano — Jarvis Codex App Server Integration

**Data:** post-C10 · **Commit di fix:** `9cefc0a`
**Metodo:** lettura integrale della spec (2164 righe) sezione per sezione, confronto
con il codice, fix dei gap. **Esito:** 200/200 test, 35 warning (baseline), `tsc` + build ok.

---

## Gap trovati e fixati

| # | Spec | Gap trovato | Fix |
|---|---|---|---|
| 1 | §27 | `run_chat` conteneva ancora il loop legacy `for round in 0..MAX_TOOL_ROUNDS` (morto a runtime: il provider non produce mai tool_calls, ma violava il piano) | Loop rimosso: una sola `complete()` = un turno Codex. Snellito il path: `system_prompt()` eliminato, `ModelMessage.tool_calls`/`ModelResponse.tool_calls` rimossi, helper test-only gated |
| 2 | §18 | `jarvis_cancel_chat` fermava solo il token locale, **non** il turno Codex | Ora risolve la workspace del request (`workspace_id_of`, nuovo + test) e chiama `interrupt_turn` best-effort (che cancella anche la token reale del plan) |
| 3 | §5+§10 | Il codex-home non conteneva l'`AGENTS.md` con le regole permanenti di Jarvis | Scritto a ogni avvio del runtime: regole ex-system_prompt (1 plan/turno, output non fidato, agenti pi/codex/opencode/claude/freebuff, policy commentary, italiano) |
| 4 | §29 | `OPENCODE_ZEN_API_KEY=` ancora in `.env.example` | Rimosso (la const Rust resta solo per lo scrub env nei subprocess) |
| 5 | §22 | I rate limits reali erano nel backend/client ma mai renderizzati | Sezione in `CodexSettingsSection`: lettura difensiva `rateLimitsByLimitId` (percentuale, used/limit, reset — mai stime) |
| — | §32 | Manca il README master | `docs/jarvis/codex/README.md` con indice + mappa spec→docs |

## Verificati già conformi (nessun fix)

- §3 processo App Server globale unico
- §6 auth ChatGPT senza token (nessuna lettura di token OAuth)
- §7 default Luna/Low + efforts dal catalogo `model/list`
- §9 thread ephemeral per workspace (+ delete su Clear/shutdown)
- §11 namespace `terminals` + tool read-only
- §13 guard 1 plan/turno (TurnSafetyState, `-32003`)
- §14–15 streaming senza reasoning (fail-closed)
- §16 checkpoint ≠ commentary
- §17 coda TTS (dedupe itemId, barge-in, skip frasi corte)
- §19 contesto compatto + tool on demand
- §20 memoria = thread Codex + memory UI
- §24 error codes `codex_*`
- §25 version check + fail-closed
- §31 isolamento workspace: i tool derivano la workspace dal thread, mai dalla request del modello
- §34 flusso end-to-end voce→plan→PTY→receipt→TTS

## Deviazioni documentate (scelte deliberate)

- §26: `JarvisConversationProvider` event-driven **non adottato** — il provider
  resta request/response perché lo streaming è già cablato via bridge C7;
- `OPENCODE_ZEN_API_KEY_ENV` mantenuto per lo scrub env (sicurezza, 5 call site);
- settings §8 parziali (`speak_commentary` sì; `personality`/`show_usage` non necessari).

## Stato finale

- Commit: `9cefc0a` `fix(jarvis): align implementation with the plan (final spec review)`
- Suite: `cargo test` 200/200 · `cargo check` 35 warning (baseline pre-C10) · `tsc` + `npm run build` verdi
- Niente push automatici senza approvazione; questo file committato e pushato su
  richiesta esplicita dell'utente.
