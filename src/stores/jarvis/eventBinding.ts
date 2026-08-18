import { listen } from "@tauri-apps/api/event";
import {
  applyCodexChatStream,
  completedCodexSpeechItem,
} from "../../lib/jarvis/chatState";
import { shouldSpeakCommentary, enqueueSpeech } from "../../lib/jarvis/ttsState";
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
    store.setState({
      codexThreads: Object.fromEntries(event.payload.threads.map((thread) => [thread.workspaceId, thread])),
    });
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
    const nextStreamFinal = { ...store.getState().codexStreamFinal };
    if (payload.kind === "turn_started") {
      nextStreamFinal[workspaceId] = undefined;
    } else if (payload.kind === "turn_completed" || payload.kind === "message_completed") {
      const completedTurn = nextStreamingTurns[workspaceId]?.find((turn) => turn.turnId === (payload.turnId ?? "unknown"));
      if (payload.kind === "turn_completed" || completedTurn?.status === "completed") {
        nextStreamFinal[workspaceId] = completedTurn?.items.find((item) => item.final)?.text;
      }
    }
    store.setState({ codexStreamingTurns: nextStreamingTurns, codexStreamFinal: nextStreamFinal });

    const completedSpeech = completedCodexSpeechItem(nextStreamingTurns, payload);
    const current = store.getState();
    if (
      completedSpeech
      && !current.codexSpokenItemIds.includes(completedSpeech.itemId)
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
