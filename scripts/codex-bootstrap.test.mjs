import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bootstrapCodexData } from "../src/lib/jarvis/codexBootstrap.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const overlaySource = source("../src/components/jarvis/JarvisGlobalOverlay.tsx");
const settingsModalSource = source("../src/components/layout/SettingsModal.tsx");
const storeSource = source("../src/stores/jarvisStore.ts");

function mockTask(log, name, result = true) {
  return async () => {
    log.push(name);
    return result;
  };
}

test("disabled Jarvis settings do not bootstrap Codex from initial defaults", async () => {
  const log = [];
  const result = await bootstrapCodexData({
    enabled: false,
    startRuntime: mockTask(log, "start"),
    loadAccount: mockTask(log, "account"),
    loadModels: mockTask(log, "models"),
    loadUsage: mockTask(log, "usage"),
    loadRateLimits: mockTask(log, "rateLimits"),
  });

  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(log, []);
});

test("React startup gates persisted settings and keeps loading/error refresh states wired", () => {
  assert.match(overlaySource, /if \(!settingsLoaded \|\| !settings\.jarvis\.enabled\) return;/);
  assert.match(settingsModalSource, /if \(!open \|\| !settingsLoaded\) return;/);
  assert.match(settingsModalSource, /refreshCodex\(\)/);
  assert.match(storeSource, /set\(\{ codexAccountLoading: true \}\)/);
  assert.match(storeSource, /set\(\{ codexRateLimitsLoading: true \}\)/);
  assert.match(storeSource, /codexError: errorMessage\(error\)/);
});

test("first startup starts Codex before loading account and statistics", async () => {
  const log = [];
  const result = await bootstrapCodexData({
    enabled: true,
    startRuntime: mockTask(log, "start"),
    loadAccount: mockTask(log, "account"),
    loadModels: mockTask(log, "models"),
    loadUsage: mockTask(log, "usage"),
    loadRateLimits: mockTask(log, "rateLimits"),
  });

  assert.deepEqual(result, { status: "ready" });
  assert.equal(log[0], "start");
  assert.equal(log[1], "account");
  assert.deepEqual(new Set(log.slice(1)), new Set(["account", "models", "usage", "rateLimits"]));
});

test("startup reports runtime and data loading errors without hiding them", async () => {
  const runtimeLog = [];
  const runtimeFailure = await bootstrapCodexData({
    enabled: true,
    startRuntime: async () => {
      runtimeLog.push("start");
      throw new Error("runtime unavailable");
    },
    loadAccount: mockTask(runtimeLog, "account"),
    loadModels: mockTask(runtimeLog, "models"),
    loadUsage: mockTask(runtimeLog, "usage"),
    loadRateLimits: mockTask(runtimeLog, "rateLimits"),
  });

  assert.equal(runtimeFailure.status, "error");
  assert.match(runtimeFailure.error, /runtime unavailable/);
  assert.deepEqual(runtimeLog, ["start"]);

  const dataFailure = await bootstrapCodexData({
    enabled: true,
    startRuntime: mockTask([], "start"),
    loadAccount: mockTask([], "account", false),
    loadModels: mockTask([], "models"),
    loadUsage: mockTask([], "usage"),
    loadRateLimits: mockTask([], "rateLimits"),
  });

  assert.equal(dataFailure.status, "error");
  assert.match(dataFailure.error, /account/i);

  const statisticLog = [];
  const statisticFailure = await bootstrapCodexData({
    enabled: true,
    startRuntime: mockTask(statisticLog, "start"),
    loadAccount: mockTask(statisticLog, "account"),
    loadModels: mockTask(statisticLog, "models"),
    loadUsage: mockTask(statisticLog, "usage", false),
    loadRateLimits: mockTask(statisticLog, "rateLimits"),
  });

  assert.equal(statisticFailure.status, "error");
  assert.match(statisticFailure.error, /usage/i);
  assert.deepEqual(new Set(statisticLog), new Set(["start", "account", "models", "usage", "rateLimits"]));
});

test("manual refresh runs the same bootstrap path again", async () => {
  const log = [];
  const options = {
    enabled: true,
    startRuntime: mockTask(log, "start"),
    loadAccount: mockTask(log, "account"),
    loadModels: mockTask(log, "models"),
    loadUsage: mockTask(log, "usage"),
    loadRateLimits: mockTask(log, "rateLimits"),
  };

  await bootstrapCodexData(options);
  await bootstrapCodexData(options);

  assert.equal(log.filter((entry) => entry === "start").length, 2);
  assert.equal(log.filter((entry) => entry === "account").length, 2);
  assert.equal(log.filter((entry) => entry === "usage").length, 2);
  assert.equal(log.filter((entry) => entry === "rateLimits").length, 2);
});
