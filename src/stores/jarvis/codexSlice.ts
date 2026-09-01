import {
  clearConversation,
  codexAccountRead,
  codexLoginCancel,
  codexLoginStart,
  codexLogout,
  codexModelList,
  codexRateLimits,
  codexRuntimeRestart,
  codexRuntimeStart,
  codexRuntimeStatus,
  codexThreadDelete,
  codexThreadEnsure,
  codexThreads,
  codexTurnInterrupt,
  codexTurnStart,
  codexTurnSteer,
  codexUsage,
  providerStatus,
} from "../../lib/jarvis/client";
import { bootstrapCodexData, createCodexBootstrapQueue } from "../../lib/jarvis/codexBootstrap";
import { clearSpeechQueue, dequeueSpeech, rememberSpoken } from "../../lib/jarvis/ttsState";
import { errorMessage, codexErrorMessage, openCodexAuthUrl, waitForCodexChatStreamBinding } from "./runtime";
import type { JarvisSlice } from "./types";

export const createCodexSlice: JarvisSlice = (set, get) => {
  const requestCodexBootstrap = createCodexBootstrapQueue(async () => {
    if (!get().settingsLoaded || !get().settings.jarvis.enabled) return;

    set({ codexError: null });
    const result = await bootstrapCodexData({
      enabled: true,
      startRuntime: () => get().startCodex(),
      loadAccount: () => get().loadCodexAccount(),
      loadModels: () => get().loadCodexModels(),
      loadUsage: () => get().loadCodexUsage(),
      loadRateLimits: () => get().loadCodexRateLimits(),
    });
    if (result.status === "error") {
      set((state) => ({ codexError: state.codexError ?? result.error }));
    }
  });

  return {
    loadProviderStatus: async () => {
      try {
        set({ providerStatus: await providerStatus() });
      } catch {
        // Advanced settings keeps the last status.
      }
    },
    loadCodexRuntime: async () => {
      try {
        const runtime = await codexRuntimeStatus();
        set({ codexRuntime: runtime, codexError: runtime.lastError ? codexErrorMessage(runtime.lastError) : get().codexError });
      } catch {
        // Runtime may be warming up; keep the last status.
      }
    },
    startCodex: async () => {
      try {
        const runtime = await codexRuntimeStart();
        set({ codexRuntime: runtime, codexError: null });
        return runtime.state === "running";
      } catch (error) {
        set({ codexError: errorMessage(error) });
        return false;
      }
    },
    loadCodexAccount: async () => {
      set({ codexAccountLoading: true });
      try {
        set({ codexAccount: await codexAccountRead(), codexAccountLoading: false });
        return true;
      } catch (error) {
        set({ codexAccountLoading: false, codexError: errorMessage(error) });
        return false;
      }
    },
    loadCodexModels: async () => {
      set({ codexModelsLoading: true });
      try {
        set({ codexModels: await codexModelList(), codexModelsLoading: false });
        return true;
      } catch (error) {
        set({ codexModelsLoading: false, codexError: errorMessage(error) });
        return false;
      }
    },
    loadCodexUsage: async () => {
      if (get().codexAccount?.account.kind !== "chatgpt") {
        set({ codexUsageLoading: false });
        return true;
      }
      set({ codexUsageLoading: true });
      try {
        set({ codexUsage: await codexUsage(), codexUsageLoading: false });
        return true;
      } catch (error) {
        set({ codexUsageLoading: false, codexError: errorMessage(error) });
        return false;
      }
    },
    loadCodexRateLimits: async () => {
      if (get().codexAccount?.account.kind !== "chatgpt") {
        set({ codexRateLimitsLoading: false });
        return true;
      }
      set({ codexRateLimitsLoading: true });
      try {
        set({ codexRateLimits: await codexRateLimits(), codexRateLimitsLoading: false });
        return true;
      } catch (error) {
        set({ codexRateLimitsLoading: false, codexError: errorMessage(error) });
        return false;
      }
    },
    bootstrapCodex: async () => {
      if (!get().settingsLoaded || !get().settings.jarvis.enabled) return;
      await requestCodexBootstrap();
    },
    refreshCodex: async () => {
      await get().bootstrapCodex();
    },
    dequeueCodexSpeech: (item) => {
      set((state) => ({
        codexSpeechQueue: dequeueSpeech(state.codexSpeechQueue, item),
        codexSpokenItemIds: rememberSpoken(state.codexSpokenItemIds, item),
      }));
    },
    clearCodexSpeech: () => {
      set((state) => ({ codexSpeechQueue: clearSpeechQueue(state.codexSpeechQueue) }));
    },
    loadCodexThreads: async () => {
      try {
        const snapshot = await codexThreads();
        set({ codexThreads: Object.fromEntries(snapshot.threads.map((thread) => [thread.workspaceId, thread])) });
      } catch {
        // Keep the last threads.
      }
    },
    ensureCodexThread: async (workspaceId) => {
      try {
        await codexThreadEnsure(workspaceId);
        await get().loadCodexThreads();
      } catch {
        // The caller surfaces the existing codex error.
      }
    },
    deleteCodexThread: async (workspaceId) => {
      try {
        await codexThreadDelete(workspaceId);
        set((state) => {
          const next = { ...state.codexThreads };
          delete next[workspaceId];
          return { codexThreads: next };
        });
      } catch {
        // Keep the local record; runtime will clear it on the next start.
      }
    },
    startCodexTurn: async (workspaceId, input) => {
      try {
        await waitForCodexChatStreamBinding();
        return await codexTurnStart(workspaceId, input);
      } catch {
        return null;
      }
    },
    interruptCodexTurn: async (workspaceId) => {
      try {
        await codexTurnInterrupt(workspaceId);
      } catch {
        // The turn may already be done.
      }
    },
    steerCodexTurn: async (workspaceId, steerText) => {
      try {
        await codexTurnSteer(workspaceId, steerText);
      } catch {
        // The caller surfaces the existing error.
      }
    },
    restartCodex: async () => {
      set({ codexLoginBusy: true, codexError: null });
      try {
        set({ codexRuntime: await codexRuntimeRestart() });
      } catch (error) {
        set({ codexError: errorMessage(error) });
      } finally {
        set({ codexLoginBusy: false });
      }
    },
    startCodexLogin: async () => {
      set({ codexLoginBusy: true, codexError: null });
      try {
        const { authUrl } = await codexLoginStart();
        set({ codexLoginBusy: false });
        await openCodexAuthUrl(authUrl);
      } catch (error) {
        set({ codexLoginBusy: false, codexError: errorMessage(error) });
      }
    },
    cancelCodexLogin: async (loginId) => {
      try {
        await codexLoginCancel(loginId);
      } catch (error) {
        set({ codexError: errorMessage(error) });
      }
    },
    logoutCodex: async () => {
      set({ codexLoginBusy: true, codexError: null });
      try {
        await codexLogout();
        set({ codexAccount: { account: { kind: "signedOut" }, requiresOpenaiAuth: true } });
      } catch (error) {
        set({ codexError: errorMessage(error) });
      } finally {
        set({ codexLoginBusy: false });
      }
    },
    clearConversation: async (workspaceId) => {
      await clearConversation(workspaceId);
      set((state) => {
        const codexThreads = { ...state.codexThreads };
        delete codexThreads[workspaceId];
        return {
          conversation: state.conversation.filter((message) => message.workspaceId !== workspaceId),
          uiIntents: state.uiIntents.filter((intent) => intent.workspaceId !== workspaceId),
          followUps: { ...state.followUps, [workspaceId]: [] },
          codexThreads,
        };
      });
    },
  };
};
