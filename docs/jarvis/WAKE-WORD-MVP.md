# Wake word MVP

## Stato della build

Il progetto espone l'astrazione locale `WakeWordEngine` e una feature Cargo
riservata, `wake-word-sherpa`, ma questa build non abilita alcun detector reale.
Non sono stati aggiunti sherpa-onnx, modelli, sidecar o asset preaddestrati:
non esiste quindi una wake word funzionante finché dipendenza, modello e
licenza di redistribuzione non vengono approvati e inclusi esplicitamente.

Quando l'utente abilita lo standby wake word, Traflix Space restituisce uno
stato `unavailable` e conserva il fallback VAD/manuale. Non apre un microfono
dedicato per un detector che non può rilevare nulla. L'abilitazione non cambia
il valore di `muted`: il mute resta sempre `off`/privacy hard-off.

## Contratto runtime

`VoiceActivationMode::WakeWord` usa la stessa sessione CPAL della successiva
registrazione. Prima della rilevazione il buffer WAV non conserva campioni; una
implementazione concreta di `WakeWordEngine` deve restituire una rilevazione
locale e il buffer passa quindi da `armed` a `recording` senza aprire un secondo
stream.

Gli eventi frontend sono:

- `jarvis://wake-state`: `off`, `standby`, `listening` o `unavailable`;
- `jarvis://voice-state`: stato della richiesta e transizione `armed` →
  `recording`;
- `jarvis://voice-level`: livello della sessione attiva.

La modalità `muted` resta un hard-off: cancella la richiesta attiva, impedisce
qualsiasi riarmo della cattura e il comando backend rifiuta un nuovo start
prima di inizializzare il provider audio o aprire CPAL.

### Stati privacy/audio

| Stato | `wake-state` / voce | CPAL | Rete |
| --- | --- | --- | --- |
| Privacy hard-off | `off` / nessuna richiesta | chiuso | nessuna |
| `WAKE_ONLY` con engine disponibile | `standby` / `armed` | un solo stream | nessuna |
| Detector non disponibile | `unavailable` / fallback VAD o manuale | solo il percorso scelto dall'utente | nessuna finché non termina una richiesta |
| Listening | `listening` / `recording` | lo stesso stream della fase wake | nessuna finché non parte lo stop/STT |

La build corrente è volutamente nel terzo caso: il modello non è presente, per
cui non simula una rilevazione e non apre CPAL per uno standby inefficace.

## Abilitazione futura

Per collegare sherpa-onnx occorre implementare soltanto l'adapter dietro
`WakeWordEngine`, validare il modello per `Hey Traflix`, quindi abilitare la
feature e includere tutti gli asset nel pacchetto Windows. Il detector non deve
scrivere PCM su disco né effettuare rete durante `wake_only`.

## Validazione Windows

1. Abilitare `Standby wake word locale` nelle impostazioni: lo stato deve
   mostrare detector non disponibile e il fallback deve restare utilizzabile.
2. Verificare che il mute mostri `Microfono disattivato`, cancelli una cattura
   attiva e impedisca un nuovo start.
3. Disabilitare il mute e provare il pulsante/hotkey VAD: deve partire una sola
   sessione CPAL.
4. Controllare l'indicatore microfono di Windows e verificare che in fallback
   non ci siano chiamate wake o asset mancanti mascherati da successo.
5. Solo dopo aver incluso un engine/modello reale, ripetere il test con
   `WAKE_ONLY` e verificare la transizione `standby` → `listening` usando lo
   stesso stream.
