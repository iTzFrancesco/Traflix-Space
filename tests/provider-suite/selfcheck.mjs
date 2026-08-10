// Self-check senza rete: valida configurazione, presenza chiave (senza esporla)
// e generazione payload. Usabile per qualsiasi provider OpenAI-compatible.

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env") });

const CONFIG = {
  // Endpoint chat completions del provider (OpenAI-compatible).
  endpoint: process.env.PROVIDER_ENDPOINT || process.env.OPENCODE_ZEN_ENDPOINT
    || "https://opencode.ai/zen/v1/chat/completions",
  // Nome della variabile d'ambiente che contiene la API key/token.
  keyEnv: process.env.PROVIDER_KEY_ENV || "OPENCODE_ZEN_API_KEY",
  // Modello di default (sovrascrivibile con --model).
  model: process.env.PROVIDER_MODEL || "deepseek-v4-flash-free",
};

function redact(value) {
  if (!value || value.length < 8) return "***";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

const apiKey = process.env[CONFIG.keyEnv];
const checks = [
  ["dotenv caricato dal root del progetto", !!apiKey || process.env[CONFIG.keyEnv] !== undefined],
  [`chiave presente (${CONFIG.keyEnv})`, !!apiKey && apiKey.length >= 8],
  ["endpoint configurato", CONFIG.endpoint.startsWith("http")],
  ["modello configurato", CONFIG.model.length > 0],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
}
console.log(`\nconfig endpoint=${CONFIG.endpoint} model=${CONFIG.model} key=${apiKey ? redact(apiKey) : "ASSENTE"}`);
if (failed) {
  console.error("\nSelf-check fallito: correggi la configurazione (vedi README.md).");
  process.exit(1);
}
console.log("\nSelf-check OK: la suite è pronta. Esegui `npm run live -- --endpoint <url> --model <modello>` per il test di latenza.");
