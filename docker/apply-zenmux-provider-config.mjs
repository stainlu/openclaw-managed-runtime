#!/usr/bin/env node
// apply-zenmux-provider-config.mjs — populate models.providers.zenmux in the
// generated openclaw.json from ZenMux's live model catalog. This is the
// canonical metadata + pricing source when the runtime routes requests through
// ZenMux, so we don't keep a separate per-provider price sheet in lockstep.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://zenmux.ai/api/v1";
const MODEL_ALIASES =
  readJsonIfExists(new URL("./model-aliases.json", import.meta.url)) ??
  readJsonIfExists(new URL("../src/model-aliases.json", import.meta.url)) ??
  {};

function readJsonIfExists(url) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function resolveZenMuxModelAlias(modelId) {
  return MODEL_ALIASES?.zenmux?.[modelId] ?? modelId;
}

function normalizeInputModalities(modalities) {
  if (!Array.isArray(modalities)) return ["text"];
  const normalized = modalities.filter(
    (value) => value === "text" || value === "image",
  );
  return normalized.length > 0 ? normalized : ["text"];
}

function pricingThreshold(item) {
  const prompt = item?.conditions?.prompt_tokens;
  if (!prompt || typeof prompt !== "object") return 0;
  if (typeof prompt.gte === "number") return prompt.gte;
  if (typeof prompt.gt === "number") return prompt.gt + 0.001;
  return 0;
}

function pickPerMillionRate(pricings, key) {
  const entries = Array.isArray(pricings?.[key]) ? pricings[key] : [];
  const candidates = entries.filter(
    (entry) => entry?.unit === "perMTokens" && entry?.currency === "USD" && typeof entry?.value === "number",
  );
  if (candidates.length === 0) return 0;
  candidates.sort((a, b) => pricingThreshold(a) - pricingThreshold(b));
  return candidates[0]?.value ?? 0;
}

export function buildZenMuxProviderConfig({
  baseUrl,
  apiKey,
  modelId,
  catalog,
}) {
  const effectiveModelId = resolveZenMuxModelAlias(modelId);
  const models = Array.isArray(catalog?.data) ? catalog.data : [];
  const resolved = models.find((model) => model?.id === effectiveModelId);
  if (!resolved) {
    throw new Error(`ZenMux model not found in /models catalog: ${effectiveModelId}`);
  }

  const contextWindow = typeof resolved.context_length === "number"
    ? resolved.context_length
    : 262144;
  const cacheWrite =
    pickPerMillionRate(resolved.pricings, "input_cache_write")
    || pickPerMillionRate(resolved.pricings, "input_cache_write_5_min")
    || pickPerMillionRate(resolved.pricings, "input_cache_write_1_h");

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    api: "openai-completions",
    models: [
      {
        id: resolved.id,
        name: resolved.display_name ?? `${resolved.id} via ZenMux`,
        reasoning: Boolean(resolved.capabilities?.reasoning),
        input: normalizeInputModalities(resolved.input_modalities),
        cost: {
          input: pickPerMillionRate(resolved.pricings, "prompt"),
          output: pickPerMillionRate(resolved.pricings, "completion"),
          cacheRead: pickPerMillionRate(resolved.pricings, "input_cache_read"),
          cacheWrite,
        },
        contextWindow,
        maxTokens: contextWindow,
      },
    ],
  };
}

export async function fetchZenMuxCatalog({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  fetchImpl = fetch,
}) {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const headers = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const res = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ZenMux /models failed (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}

export async function main(argv = process.argv) {
  const [, , configPath, modelId] = argv;
  const apiKey = process.env.ZENMUX_API_KEY;
  const baseUrl = process.env.ZENMUX_BASE_URL || DEFAULT_BASE_URL;
  if (!configPath || !modelId) {
    process.stderr.write(
      "usage: apply-zenmux-provider-config.mjs <config-path> <raw-model-id>\n",
    );
    process.exit(1);
  }
  if (!apiKey) {
    process.stderr.write(
      "[apply-zenmux-provider-config] ZENMUX_API_KEY is required\n",
    );
    process.exit(1);
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    process.stderr.write(
      `[apply-zenmux-provider-config] failed to read/parse ${configPath}: ${err.message}\n`,
    );
    process.exit(1);
  }

  let catalog;
  try {
    catalog = await fetchZenMuxCatalog({ baseUrl, apiKey });
  } catch (err) {
    process.stderr.write(
      `[apply-zenmux-provider-config] failed to fetch ZenMux /models: ${err.message}\n`,
    );
    process.exit(1);
  }

  let providerConfig;
  try {
    providerConfig = buildZenMuxProviderConfig({
      baseUrl,
      apiKey,
      modelId,
      catalog,
    });
  } catch (err) {
    process.stderr.write(
      `[apply-zenmux-provider-config] failed to build provider config: ${err.message}\n`,
    );
    process.exit(1);
  }

  cfg.models = cfg.models ?? {};
  cfg.models.mode = cfg.models.mode ?? "merge";
  cfg.models.providers = cfg.models.providers ?? {};
  cfg.models.providers.zenmux = providerConfig;

  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
  process.stdout.write(
    `[apply-zenmux-provider-config] populated models.providers.zenmux for ${modelId} from live ZenMux catalog\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
