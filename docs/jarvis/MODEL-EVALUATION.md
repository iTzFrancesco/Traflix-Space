# Traflix Jarvis — valutazione modelli

**Data verifica web:** 2026-08-06.
**Stato:** inventario e piano di benchmark; nessun benchmark live e nessuna API key letta.

## Criteri

Jarvis necessita di due profili diversi:

- **Fast router:** classificazione e structured output per comandi brevi, con latenza e costo bassi;
- **Contextual planner:** retrieval, riferimenti anaforici, confronto di Agent session, follow-up e delega con tool calling affidabile.

L'interfaccia comune deve richiedere structured output, tool calling, streaming, summarization, context budgeting, health check e fallback. Nessun modello è hardcoded nel runtime futuro; la matrice è una fotografia e deve essere rinfrescata da metadata/configurazione.

## Modelli verificati oggi

OpenCode Zen dichiara una lista curata e testata per coding agents, login opzionale, pagamento per request e lista completa/metadata a `https://opencode.ai/zen/v1/models`. La pagina corrente pubblica gli ID seguenti e i prezzi per 1M token. I modelli free sono dichiarati disponibili “per un periodo limitato”, senza una quota fissa pubblicata: non vanno assunti come fallback stabile.

Groq documenta `llama-3.1-8b-instant` con tool use, JSON Object Mode, context window 131,072, costo `$0.05` input / `$0.08` output per 1M token e rate limit base pubblicato 30 RPM, 14.4K RPD, 6K TPM, 500K TPD. La pagina account può applicare limiti diversi.

| Model ID | Provider | Costo pubblicato | Quota gratuita | Rate limit | Context window | Tool calling | Structured output | Latenza | Italiano | Repo context | Stabilità | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `llama-3.1-8b-instant` | Groq | `$0.05` in / `$0.08` out per 1M | piano/organizzazione, non garantita | 30 RPM; 14.4K RPD; 6K TPM; 500K TPD base | 131K | Sì, documentato | JSON Object Mode documentato; schema completo da verificare | candidato fast; Groq pubblica ~560 tps | da benchmark | sufficiente per routing, non ancora provato sul package | disponibile oggi, soggetto a policy | provider LLM configurato successivo |
| `deepseek-v4-flash-free` | OpenCode Zen | Free temporaneo | sì, periodo limitato; quota non pubblicata | non pubblicato; verificare metadata/account | da verificare su `/v1/models` | endpoint chat completions; capability da verificare | da verificare | da misurare | da benchmark | candidato planner economico, non provato | free temporaneo/privacy caveat | altro Zen paid/Groq |
| `mimo-v2.5-free` | OpenCode Zen | Free temporaneo | sì, periodo limitato; quota non pubblicata | non pubblicato | da verificare | endpoint chat completions; da verificare | da verificare | da misurare | da benchmark | candidato planner free, non provato | free temporaneo/privacy caveat | DeepSeek free/paid |
| `big-pickle` | OpenCode Zen | Free temporaneo | sì, periodo limitato | non pubblicato | da verificare | endpoint chat completions; da verificare | da verificare | da misurare | da benchmark | candidato sperimentale, non usare per dati confidenziali | stealth/free temporaneo | non affidarlo come unico fallback |
| `gemini-3.5-flash` | OpenCode Zen | `$1.50` in / `$9.00` out per 1M | no quota Zen pubblicata | non pubblicato da Zen | metadata da verificare | endpoint Google model; da verificare nel client | da verificare | da misurare | candidato, da benchmark | candidato contextual planner | dipende provider/versione | DeepSeek/Claude/Groq |
| `gemini-3.5-flash-lite` | OpenCode Zen | `$0.30` in / `$2.50` out | no quota Zen pubblicata | non pubblicato | metadata da verificare | da verificare | da verificare | da misurare | candidato | planner leggero/summary da verificare | dipende provider | fast router provider-agnostic |
| `deepseek-v4-flash` | OpenCode Zen | `$0.14` in / `$0.28` out | no | non pubblicato | metadata da verificare | endpoint OpenAI-compatible; da verificare | da verificare | da misurare | da benchmark | candidato costo/qualità | stabile solo se endpoint resta disponibile | free/altro provider |
| `gpt-5.4-mini` | OpenCode Zen | `$0.75` in / `$4.50` out | no | non pubblicato | metadata da verificare | endpoint Responses; da verificare | da verificare | da misurare | candidato | opzione forte più costosa, da benchmark | optional, non default | Gemini/DeepSeek |
| `claude-haiku-4-5` | OpenCode Zen | `$1.00` in / `$5.00` out | no | non pubblicato | metadata da verificare | endpoint Messages; da verificare | da verificare | da misurare | candidato | summary/router alternativo, da benchmark | dipende provider | altro modello configured |

La colonna “da verificare” è intenzionale: la pagina Zen pubblica endpoint, SDK e pricing, ma non garantisce per ogni modello context window, schema strict, rate limit o qualità italiana. Questi dati vanno rilevati dal metadata endpoint pubblico e dal client configurato, senza credenziali nel repository.

## Modelli free e privacy

OpenCode Zen indica che i modelli free sono temporanei. La stessa pagina avverte che per alcuni endpoint free i dati possono essere conservati/usati per migliorare il modello o essere soggetti a trial provider; per questo il Context Package di Jarvis deve redigere sempre secret e file sensibili, e i modelli free non devono ricevere dati confidenziali senza una policy esplicita. Sono possibili monthly spending limit e model access restrictions in Zen, ma sono impostazioni account/workspace, non una quota gratuita garantita.

## Raccomandazione provvisoria

1. Non fissare ancora il contextual planner.
2. Usare `llama-3.1-8b-instant` come candidato iniziale del fast router soltanto dopo health check e verifica del limite account; la documentazione conferma tool use e JSON mode.
3. Per il planner, mettere in shortlist `deepseek-v4-flash`, `gemini-3.5-flash` e un modello più forte opzionale come `gpt-5.4-mini` o `claude-haiku-4-5`, selezionati da metadata, costo e benchmark.
4. Usare `deepseek-v4-flash-free` e `mimo-v2.5-free` solo come candidati di sviluppo non confidenziale e con fallback immediato; non considerarli SLA.
5. Conservare provider/model ID nella configurazione, non nel Context Package come segreto e non in codice applicativo.

## Benchmark futuro

Il benchmark deve essere offline e sintetico, senza repository privati reali e senza benchmark a pagamento in Fase 1.

### Dataset

Creare Context Package sintetici con:

- 3–5 workspace fittizie con stack diversi;
- Git status/diff, file tree, manifest, regole e ADR;
- 2–6 Agent session per workspace, con Agent turn, completion notification, messaggi, tool call, errore e risultato;
- riferimenti ambigui (“quello”, “l'ultimo Codex”, “gli agenti aperti”);
- prompt injection in README/output che deve essere ignorata;
- package piccolo, medio e vicino al context limit;
- italiano tecnico e richieste vocali trascritte con errori controllati.

### Task e misure

Misurare per profilo:

- correttezza del target workspace e dell'Agent session;
- precision/recall degli estratti file/simboli/sessioni;
- validità dello structured output e tool arguments;
- numero di tool call e rispetto dell'allowlist;
- qualità del follow-up, delega e confronto risultati;
- gestione di stato incompleto/permission pending;
- latenza time-to-first-token e completamento;
- costo stimato per richiesta;
- italiano, stabilità su retry/429 e qualità del fallback;
- mancata divulgazione di secret e resistenza a injection.

Ogni run registra model ID, provider, timestamp, context hash, prompt version, schema version, temperature/parametri, latenza, token usage, errori e output normalizzato. I risultati non diventano una decisione finché non sono ripetibili su più seed/varianti e non vengono controllati da un revisore.

## Pipeline vocale

### STT

Groq documenta:

| Modello | Uso | Costo pubblicato | Velocità | Word error rate pubblicato | Fallback |
|---|---|---|---|---|---|
| `whisper-large-v3-turbo` | trascrizione multilingue rapida | `$0.04`/ora | 216x | 12% | `whisper-large-v3` |
| `whisper-large-v3` | precisione multilingue/translation | `$0.111`/ora | 189x | 10.3% | provider STT configurabile |

I due modelli accettano audio multilingue; la documentazione segnala limiti di dimensione e rate limit di base 20 RPM, 2K RPD e 7.2K audio seconds/hour, 28.8K/day. Il primo MVP dovrebbe usare push-to-talk, segmenti brevi, italiano esplicito, timeout e cancellazione. Whisper è STT, non TTS.

### TTS

Edge TTS è soltanto una baseline gratuita da valutare: la pipeline futura deve astrarre `synthesize(text, locale, voice, cancelToken)`, riconoscere che dipende da un servizio/implementazione non garantita come API locale stabile e avere fallback silenzioso a testo. Non è stata installata né integrata.

### Sequenza

`Microfono → STT → normalizzazione trascrizione → Context Package → LLM/tool loop → risposta → TTS`

La normalizzazione conserva transcript originale separato dal testo interpretato, corregge solo errori sicuri e mostra l'interpretazione quando un nome workspace/agent è ambiguo. Stop speech interrompe TTS; cancellazione globale interrompe audio, planner, tool loop e adapter.

## Dati mancanti prima di fissare il modello

- metadata corrente per context window, modalities, tool calling e strict structured output di ogni modello Zen;
- rate limit effettivo dell'account e policy dei modelli free;
- latenza dalla VPS/desktop Windows e differenza regionale;
- qualità su italiano tecnico, file path Windows e output terminale;
- retention e privacy per ogni provider selezionato;
- comportamento su 429, timeout, stream interrotto e fallback;
- benchmark sintetico sui Context Package sopra definiti.

## Fonti

- [OpenCode Zen: modelli, endpoint, pricing, free models e privacy](https://opencode.ai/docs/zen) — pagina verificata il 2026-08-06.
- [OpenCode Zen models metadata endpoint](https://opencode.ai/zen/v1/models) — da interrogare in una fase con provider configurato, senza leggere credenziali locali.
- [Groq `llama-3.1-8b-instant`](https://console.groq.com/docs/model/llama-3.1-8b-instant).
- [Groq rate limits](https://console.groq.com/docs/rate-limits).
- [Groq speech-to-text](https://console.groq.com/docs/speech-to-text).
- [Groq Whisper Large V3 Turbo](https://console.groq.com/docs/model/whisper-large-v3-turbo).
- [Groq Whisper Large V3](https://console.groq.com/docs/model/whisper-large-v3).
