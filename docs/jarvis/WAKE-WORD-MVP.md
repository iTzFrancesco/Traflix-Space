# Wake word MVP

## Stato della build

Il progetto espone l'astrazione locale `WakeWordEngine` e una feature Cargo
riservata, `wake-word-sherpa`. Poiché questa build non contiene un modello
keyword-spotting approvato, usa un fallback VAD locale bounded.
Non sono stati aggiunti sherpa-onnx, modelli, sidecar o asset preaddestrati:
la frase configurata non viene quindi riconosciuta acusticamente finché
dipendenza, modello e licenza di redistribuzione non vengono approvati e
inclusi esplicitamente.

Quando l'utente abilita lo standby wake word, Traflix Space restituisce uno
stato `fallback` e avvia il detector VAD nello stesso stream CPAL. Non apre un
microfono dedicato né invia audio allo STT in standby. L'abilitazione non
cambia il valore di `muted`: il mute resta sempre `off`/privacy hard-off.

## Contratto runtime

`VoiceActivationMode::WakeWord` usa la stessa sessione CPAL della successiva
registrazione. Prima della rilevazione il buffer WAV non conserva campioni; il
fallback VAD locale (o una futura implementazione concreta di
`WakeWordEngine`) deve restituire una rilevazione e il buffer passa quindi da
`armed` a `recording` senza aprire un secondo stream.

Gli eventi frontend sono:

- `jarvis://wake-state`: `off`, `standby`, `listening`, `fallback` o `unavailable`;
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
| Modello non incluso | `fallback` / VAD locale | un solo stream | nessuna in standby |
| Listening | `listening` / `recording` | lo stesso stream della fase wake | nessuna finché non parte lo stop/STT |

La build corrente usa il caso `fallback`: il modello non è presente, quindi la
frase configurata non può essere validata acusticamente; l'attivazione locale
richiede comunque tre frame consecutivi di voce sopra la soglia bounded.

## Abilitazione futura

Per collegare sherpa-onnx occorre implementare soltanto l'adapter dietro
`WakeWordEngine`, validare il modello per `Hey Traflix`, quindi abilitare la
feature e includere tutti gli asset nel pacchetto Windows. Il detector non deve
scrivere PCM su disco né effettuare rete durante `wake_only`.

## Validazione Windows

1. Abilitare `Standby wake word locale` nelle impostazioni: lo stato deve
   mostrare `fallback VAD locale`, non un errore bloccante.
2. Verificare che il mute mostri `Microfono disattivato`, cancelli una cattura
   attiva e impedisca un nuovo start.
3. Disabilitare il mute e provare il pulsante/hotkey VAD: deve partire una sola
   sessione CPAL.
4. Controllare l'indicatore microfono di Windows e verificare che il fallback
   resti locale, non invii audio in standby e non apra un secondo microfono.
5. Solo dopo aver incluso un engine/modello reale, ripetere il test con
   `WAKE_ONLY` e verificare la transizione `standby` → `listening` usando lo
   stesso stream.

La suite deterministica copre anche i confini che non richiedono hardware o un modello:

- `wake.rs`: configurazione bounded, detector locale astratto, fallback VAD e transizioni di stato;
- `capture.rs`: nessun sample conservato prima del match e riuso dello stesso buffer dopo l'attivazione;
- `registry.rs`: `WakeWord` resta `Armed` finché il capture session non segnala il match, poi passa a `Recording`;
- `scripts/jarvis-wake-word.test.mjs`: separazione da mute privacy, singolo stream CPAL, fallback VAD ed eventi di stato.

Questi test non certificano l'accuratezza acustica né l'apertura reale di un device CPAL. La verifica runtime completa richiede ancora un adapter locale approvato, modello/asset con licenza e un microfono Windows funzionante.
