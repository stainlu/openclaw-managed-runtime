const DEFAULT_ZENMUX_BASE_URL = "https://zenmux.ai/api/v1";
const CATALOG_TTL_MS = 5 * 60_000;

type ZenMuxPricingEntry = {
  value?: number;
  unit?: string;
  currency?: string;
  conditions?: {
    prompt_tokens?: {
      unit?: string;
      gte?: number;
      gt?: number;
    };
  };
};

type ZenMuxCatalogModel = {
  id?: string;
  pricings?: Record<string, ZenMuxPricingEntry[] | undefined>;
};

type ZenMuxCatalog = {
  data?: ZenMuxCatalogModel[];
};

type FetchImpl = typeof fetch;

type CatalogCacheEntry = {
  expiresAt: number;
  catalog?: ZenMuxCatalog;
  inflight?: Promise<ZenMuxCatalog>;
};

const catalogCache = new Map<string, CatalogCacheEntry>();

export function normalizeZenMuxBaseUrl(baseUrl: string | undefined): string {
  return String(baseUrl || DEFAULT_ZENMUX_BASE_URL).replace(/\/+$/, "");
}

export function resolveZenMuxCatalogModelId(
  model: string | undefined,
  passthroughEnv: Record<string, string>,
): string | undefined {
  if (!model) return undefined;
  if (model.startsWith("zenmux/")) {
    return model.slice("zenmux/".length);
  }
  return passthroughEnv.ZENMUX_API_KEY ? model : undefined;
}

export function clearZenMuxCatalogCache(): void {
  catalogCache.clear();
}

function pricingThresholdTokens(entry: ZenMuxPricingEntry): number {
  const prompt = entry.conditions?.prompt_tokens;
  if (!prompt) return 0;
  const scale = prompt.unit === "kTokens" ? 1_000 : 1;
  if (typeof prompt.gte === "number") return prompt.gte * scale;
  if (typeof prompt.gt === "number") return (prompt.gt * scale) + 1;
  return 0;
}

function matchingUsdEntries(
  pricings: Record<string, ZenMuxPricingEntry[] | undefined> | undefined,
  key: string,
  unit: string,
): ZenMuxPricingEntry[] {
  const entries = Array.isArray(pricings?.[key]) ? pricings[key] : [];
  return entries.filter(
    (entry) =>
      entry?.unit === unit &&
      entry?.currency === "USD" &&
      typeof entry?.value === "number",
  );
}

function pickPerMillionRate(
  pricings: Record<string, ZenMuxPricingEntry[] | undefined> | undefined,
  key: string,
  tokens: number,
): number {
  const entries = matchingUsdEntries(pricings, key, "perMTokens");
  if (entries.length === 0) return 0;
  entries.sort((a, b) => pricingThresholdTokens(a) - pricingThresholdTokens(b));
  let chosen = entries[0];
  for (const entry of entries) {
    if (tokens >= pricingThresholdTokens(entry)) chosen = entry;
  }
  return chosen?.value ?? 0;
}

function pickPerRequestRate(
  pricings: Record<string, ZenMuxPricingEntry[] | undefined> | undefined,
): number {
  const entries = matchingUsdEntries(pricings, "request", "perCount");
  return entries[0]?.value ?? 0;
}

export function estimateZenMuxTurnCostFromCatalog(args: {
  catalog: ZenMuxCatalog;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
}): number | undefined {
  const resolved = Array.isArray(args.catalog.data)
    ? args.catalog.data.find((model) => model?.id === args.modelId)
    : undefined;
  if (!resolved) return undefined;
  const inputRate = pickPerMillionRate(resolved.pricings, "prompt", args.tokensIn);
  const outputRate = pickPerMillionRate(resolved.pricings, "completion", args.tokensOut);
  const requestRate = pickPerRequestRate(resolved.pricings);
  return (
    requestRate +
    (args.tokensIn / 1_000_000) * inputRate +
    (args.tokensOut / 1_000_000) * outputRate
  );
}

export async function fetchZenMuxCatalogCached(args: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}): Promise<ZenMuxCatalog> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const baseUrl = normalizeZenMuxBaseUrl(args.baseUrl);
  const cacheKey = `${baseUrl}|${args.apiKey}`;
  const now = Date.now();
  const cached = catalogCache.get(cacheKey);
  if (cached?.catalog && cached.expiresAt > now) {
    return cached.catalog;
  }
  if (cached?.inflight) {
    return cached.inflight;
  }

  const inflight = (async () => {
    const res = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${args.apiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ZenMux /models failed (${res.status}): ${text || res.statusText}`);
    }
    const catalog = (await res.json()) as ZenMuxCatalog;
    catalogCache.set(cacheKey, {
      catalog,
      expiresAt: Date.now() + CATALOG_TTL_MS,
    });
    return catalog;
  })();

  catalogCache.set(cacheKey, {
    expiresAt: now + CATALOG_TTL_MS,
    inflight,
  });

  try {
    return await inflight;
  } catch (err) {
    catalogCache.delete(cacheKey);
    throw err;
  }
}

export async function estimateZenMuxTurnCostUsd(args: {
  model: string | undefined;
  tokensIn: number;
  tokensOut: number;
  passthroughEnv: Record<string, string>;
  fetchImpl?: FetchImpl;
}): Promise<number | undefined> {
  const modelId = resolveZenMuxCatalogModelId(args.model, args.passthroughEnv);
  const apiKey = args.passthroughEnv.ZENMUX_API_KEY;
  if (!modelId || !apiKey) return undefined;
  const catalog = await fetchZenMuxCatalogCached({
    apiKey,
    baseUrl: args.passthroughEnv.ZENMUX_BASE_URL,
    fetchImpl: args.fetchImpl,
  });
  return estimateZenMuxTurnCostFromCatalog({
    catalog,
    modelId,
    tokensIn: args.tokensIn,
    tokensOut: args.tokensOut,
  });
}
