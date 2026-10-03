import { listen } from "@tauri-apps/api/event";
import {
  applyCodexChatStream,
  completedCodexSpeechItem,
  reconcileStreamingTurnsWithThreads,
} from "../../lib/jarvis/chatState";
import {
  shouldSpeakCommentary,
  dropStaleSpeechForTurn,
  enqueueSpeech,
  settleSpeechForTurn,
  speechItemKey,
} from "../../lib/jarvis/ttsState";
import { codexErrorMessage, setCodexChatStreamAvailable, setCodexChatStreamBindingReady } from "./runtime";
import type {
  CodexAccountEvent,
  CodexChatStreamEvent,
  CodexRuntimeStatus,
  CodexThreadSnapshot,
  JarvisStoreAccess,
} from "./types";

export function bindCodexEventsForStore(store: JarvisStoreAccess): () => void {
  setCodexChatStreamAvailable(false);
  const unlisteners: Array<() => void> = [];
  const chatStreamTimings = new Map<string, { startedAt: number; toolName: string | null }>();
  const startedAt = () => performance.now();
  const durationMs = (anchor: { startedAt: number }) => Math.round(performance.now() - anchor.startedAt);

  void listen<CodexRuntimeStatus>("jarvis://codex-runtime", (event) => {
    store.setState((state) => ({
      codexRuntime: event.payload,
      codexError: event.payload.lastError ? codexErrorMessage(event.payload.lastError) : state.codexError,
    }));
  }).then((unlisten) => unlisteners.push(unlisten));

  void listen<CodexAccountEvent>("jarvis://codex-account", (event) => {
    const method = event.payload.method;
    if (method === "account/login/completed" || method === "account/updated") {
      void store.getState().bootstrapCodex();
    }
  }).then((unlisten) => unlisteners.push(unlisten));

  void listen<unknown>("jarvis://codex-rate-limits", (event) => {
    store.setState({ codexRateLimits: { snapshot: event.payload } });
  }).then((unlisten) => unlisteners.push(unlisten));

  void listen<CodexThreadSnapshot>("jarvis://codex-thread", (event) => {
    const threads = Object.fromEntries(event.payload.threads.map((thread) => [thread.workspaceId, thread]));
    // The thread snapshot is the authority for which turn is still running.
    // Retire local `active` markers the backend no longer owns so a missed
    // terminal stream event cannot leave a perpetual working turn after a
    // workspace switch. Newly interrupted turns settle their still-pending
    // speech exactly like a turn_interrupted event; active playback is
    // stopped by the overlay worker, preserving the no-interrupt policy for
    // completed turns.
    const reconciled = reconcileStreamingTurnsWithThreads(
      store.getState().codexStreamingTurns,
      threads,
      new Date().toISOString(),
    );
    store.setState((state) => ({
      codexThreads: threads,
      codexStreamingTurns: reconciled.turns,
      ...(reconciled.interrupted.length > 0
        ? {
            codexSpeechQueue: reconciled.interrupted.reduce(
              (queue, key) => settleSpeechForTurn(queue, key.workspaceId, key.turnId, null),
              state.codexSpeechQueue,
            ),
          }
        : {}),
    }));
  }).then((unlisten) => unlisteners.push(unlisten));

  const chatStreamRegistration = listen<CodexChatStreamEvent>("jarvis://chat-stream", (event) => {
    const payload = event.payload;
    const meta = {
      requestId: payload.requestId ?? undefined,
      workspaceId: payload.workspaceId ?? undefined,
      turnId: payload.turnId ?? undefined,
      itemId: payload.itemId ?? undefined,
    };
    switch (payload.kind) {
      case "turn_started":
        chatStreamTimings.set(`turn:${payload.turnId}`, { startedAt: startedAt(), toolName: null });
        console.info("[Jarvis Codex] turn started", meta);
        break;
      case "tool_started":
        chatStreamTimings.set(`tool:${payload.itemId}`, { startedAt: startedAt(), toolName: payload.toolName });
        console.info("[Jarvis Codex tool] started", { ...meta, tool: payload.toolName ?? undefined });
        break;
      case "tool_completed": {
        const anchor = chatStreamTimings.get(`tool:${payload.itemId}`);
        console.info("[Jarvis Codex tool] completed", {
          ...meta,
          tool: payload.toolName ?? anchor?.toolName ?? undefined,
          durationMs: anchor ? durationMs(anchor) : undefined,
        });
        if (anchor) chatStreamTimings.delete(`tool:${payload.itemId}`);
        break;
      }
      case "message_completed":
        console.info("[Jarvis Codex] commentary completed", { ...meta, chars: payload.text?.length ?? 0 });
        break;
      case "turn_completed": {
        const anchor = chatStreamTimings.get(`turn:${payload.turnId}`);
        console.info("[Jarvis Codex] turn completed", { ...meta, durationMs: anchor ? durationMs(anchor) : undefined });
        if (anchor) chatStreamTimings.delete(`turn:${payload.turnId}`);
        break;
      }
      case "turn_failed":
      case "turn_interrupted": {
        const anchor = chatStreamTimings.get(`turn:${payload.turnId}`);
        console.info(`[Jarvis Codex] turn ${payload.kind.slice(5)}`, { ...meta, durationMs: anchor ? durationMs(anchor) : undefined });
        if (anchor) chatStreamTimings.delete(`turn:${payload.turnId}`);
        break;
      }
      default:
        break;
    }

    const nextStreamingTurns = applyCodexChatStream(store.getState().codexStreamingTurns, payload);
    const workspaceId = payload.workspaceId ?? "unknown";
    const turnId = payload.turnId ?? "unknown";
    const nextStreamFinal = { ...store.getState().codexStreamFinal };
    if (payload.kind === "turn_started") {
      nextStreamFinal[workspaceId] = undefined;
      // A new turn owns the single audio channel. Drop still-pending
      // commentary so the new question cannot speak the previous
      // workspace/conversation answer first (FIFO lag). Active playback
      // finishes per the no-interrupt policy; only pending speech moves.
      if (workspaceId !== "unknown" && turnId !== "unknown") {
        store.setState((state) => ({
          codexSpeechQueue: dropStaleSpeechForTurn(state.codexSpeechQueue, workspaceId, turnId),
        }));
      }
    } else if (payload.kind === "turn_completed" || payload.kind === "message_completed") {
      const completedTurn = nextStreamingTurns[workspaceId]?.find((turn) => turn.turnId === (payload.turnId ?? "unknown"));
      if (payload.kind === "turn_completed" || completedTurn?.status === "completed") {
        nextStreamFinal[workspaceId] = completedTurn?.items.find((item) => item.final)?.text;
      }
    }
    const turnCancelled =
      payload.kind === "turn_failed" ||
      payload.kind === "turn_interrupted";
    store.setState((state) => ({
      codexStreamingTurns: nextStreamingTurns,
      codexStreamFinal: nextStreamFinal,
      // A completed turn keeps every queued intermediate in FIFO order so all
      // Jarvis messages are spoken (grey rows + white final). Only a
      // failed/interrupted turn drops its still-pending items to respect
      // stop/cancel; active playback is stopped by the overlay worker.
      ...(turnCancelled
        ? {
            codexSpeechQueue: settleSpeechForTurn(
              state.codexSpeechQueue,
              workspaceId,
              turnId,
              null,
            ),
          }
        : {}),
    }));

    const completedSpeech = completedCodexSpeechItem(nextStreamingTurns, payload);
    const current = store.getState();
    if (
      completedSpeech
      && !current.codexSpokenItemIds.includes(speechItemKey(completedSpeech))
      && current.settings.jarvis.codex.speakCommentary
      && current.settings.jarvis.voiceOutput.enabled
      && current.settings.jarvis.voiceOutput.autoSpeak
      && Boolean(current.settings.jarvis.voiceOutput.privacyConsent && current.settings.jarvis.voiceOutput.privacyConsentAt)
      && !current.settings.jarvis.muted
      && shouldSpeakCommentary(completedSpeech.text)
    ) {
      store.setState((state) => ({ codexSpeechQueue: enqueueSpeech(state.codexSpeechQueue, completedSpeech) }));
      console.info("[Jarvis TTS] commentary queued", { ...meta, chars: completedSpeech.text.length });
    }
  });

  void chatStreamRegistration.then(
    (unlisten) => {
      setCodexChatStreamAvailable(true);
      unlisteners.push(unlisten);
    },
    (error) => {
      setCodexChatStreamAvailable(false);
      console.error("[Jarvis Codex] chat-stream listener registration failed", error);
    },
  );
  setCodexChatStreamBindingReady(chatStreamRegistration.then(
    () => undefined,
    (error) => {
      console.error("[Jarvis Codex] chat-stream listener registration failed", error);
    },
  ));

  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
