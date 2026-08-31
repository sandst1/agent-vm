#!/usr/bin/env node


import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Editor-Version": "vscode/1.99.3",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "Copilot-Integration-Id": "vscode-chat",
};
const DEFAULT_APIS = {
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com",
  "github-copilot": "https://api.githubcopilot.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
};

const authPath = process.env.OPENCODE_AUTH_PATH
  || join(homedir(), ".local", "share", "opencode", "auth.json");
const configPath = process.env.OPENCODE_CONFIG_PATH
  || join(homedir(), ".config", "opencode", "opencode.json");
const modelsPath = process.env.OPENCODE_MODELS_PATH
  || join(homedir(), ".cache", "opencode", "models.json");

const authStore = readJson(authPath) || {};
const hostConfig = readJson(configPath) || {};
const modelsCatalog = readJson(modelsPath) || {};
const hostProviders = hostConfig.provider || hostConfig.providers || {};

const copilotTokenCache = new Map();

const allowedProviders = new Set([
  ...Object.keys(authStore).filter((id) => hasUsableAuth(authStore[id])),
  ...Object.keys(hostProviders).filter((id) => extractConfigApiKey(hostProviders[id])),
]);

if (allowedProviders.size === 0) {
  throw new Error(`No authenticated OpenCode providers found under ${authPath}`);
}

const server = createServer(async (request, response) => {
  try {
    await proxyRequest(request, response);
  } catch (error) {
    const status = error instanceof BrokerError ? error.status : 502;
    const message = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) {
      response.writeHead(status, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: message }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Broker did not bind a TCP port");
  process.stdout.write(`${JSON.stringify({
    port: address.port,
    providers: [...allowedProviders].sort(),
  })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function proxyRequest(request, response) {
  const incoming = new URL(request.url || "/", "http://127.0.0.1");
  const match = incoming.pathname.match(/^\/provider\/([^/]+)(\/.*)?$/);
  if (!match) throw new BrokerError(404, "Unknown broker route");

  const providerId = decodeURIComponent(match[1]);
  if (!allowedProviders.has(providerId)) throw new BrokerError(403, "Provider is not available");

  const upstreamPath = match[2] || "/";
  if (!isAllowedModelPath(request.method, upstreamPath)) {
    throw new BrokerError(403, "Only model inference and catalog routes are allowed");
  }

  const auth = await resolveAuth(providerId);
  const baseUrl = resolveUpstreamBase(providerId);
  if (!baseUrl) throw new BrokerError(502, `Provider '${providerId}' has no base URL`);

  const upstream = new URL(upstreamPath.replace(/^\//, ""), ensureTrailingSlash(baseUrl));
  copySafeQuery(incoming, upstream);

  const headers = createUpstreamHeaders(request.headers, auth, providerId);
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await readBody(request);
  const upstreamResponse = await fetch(upstream, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  const responseHeaders = {};
  for (const [name, value] of upstreamResponse.headers) {
    if (!isHopByHopHeader(name) && name.toLowerCase() !== "set-cookie") responseHeaders[name] = value;
  }
  response.writeHead(upstreamResponse.status, responseHeaders);
  if (!upstreamResponse.body) {
    response.end();
    return;
  }
  for await (const chunk of upstreamResponse.body) response.write(chunk);
  response.end();
}

async function resolveAuth(providerId) {
  const record = authStore[providerId];
  if (record && hasUsableAuth(record)) {
    if (record.type === "oauth") {
      const apiKey = providerId === "github-copilot"
        ? await resolveCopilotToken(record)
        : (record.access || record.refresh);
      return { apiKey, copilot: providerId === "github-copilot" };
    }
    return { apiKey: record.key };
  }

  const fromConfig = extractConfigApiKey(hostProviders[providerId]);
  if (fromConfig) return { apiKey: fromConfig };
  throw new BrokerError(502, `Authentication unavailable for provider '${providerId}'`);
}

async function resolveCopilotToken(record) {
  const minValid = Date.now() + 5 * 60 * 1000;
  if (record.access && record.expires > minValid) return record.access;

  const cached = copilotTokenCache.get(record.refresh);
  if (cached && cached.expires > minValid) return cached.token;

  const exchanged = await exchangeCopilotToken(record.refresh, record.enterpriseUrl);
  if (exchanged) {
    copilotTokenCache.set(record.refresh, exchanged);
    return exchanged.token;
  }

  // Current OpenCode Copilot plugin sends the GitHub OAuth token directly.
  return record.refresh;
}

async function exchangeCopilotToken(refresh, enterpriseUrl) {
  const tokenUrl = enterpriseUrl
    ? `https://api.${String(enterpriseUrl).replace(/^https?:\/\//, "").replace(/\/$/, "")}/copilot_internal/v2/token`
    : COPILOT_TOKEN_URL;
  try {
    const response = await fetch(tokenUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${refresh}`,
        ...COPILOT_HEADERS,
      },
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    if (!data?.token) return undefined;
    return {
      token: data.token,
      expires: (data.expires_at ? data.expires_at * 1000 : Date.now() + 30 * 60 * 1000),
    };
  } catch {
    return undefined;
  }
}

function resolveUpstreamBase(providerId) {
  const fromConfig = hostProviders[providerId]?.options?.baseURL;
  if (typeof fromConfig === "string" && fromConfig && !fromConfig.includes("/provider/")) {
    return fromConfig;
  }
  const fromCatalog = modelsCatalog[providerId]?.api;
  if (typeof fromCatalog === "string" && fromCatalog) return fromCatalog;
  return DEFAULT_APIS[providerId];
}

function extractConfigApiKey(provider) {
  const raw = provider?.options?.apiKey;
  if (typeof raw !== "string" || !raw) return undefined;
  const envMatch = raw.match(/^\{env:([^}]+)\}$/);
  if (envMatch) return process.env[envMatch[1]] || undefined;
  const fileMatch = raw.match(/^\{file:([^}]+)\}$/);
  if (fileMatch) {
    const filePath = fileMatch[1].replace(/^~(?=\/|$)/, homedir());
    try {
      return readFileSync(filePath, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (/^\{(?:env|file):/.test(raw)) return undefined;
  return raw;
}

function hasUsableAuth(record) {
  if (!record || typeof record !== "object") return false;
  if (record.type === "oauth") return Boolean(record.refresh || record.access);
  return Boolean(record.key);
}

function isAllowedModelPath(method, path) {
  const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (method === "GET") return /^\/(?:v1\/)?models$/.test(normalized);
  if (method !== "POST") return false;
  return /^\/(?:v1\/)?(?:chat\/completions|responses|messages|messages\/count_tokens)$/.test(normalized);
}

function createUpstreamHeaders(incomingHeaders, auth, providerId) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (!value || isSensitiveHeader(name) || isHopByHopHeader(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  if (auth.copilot) {
    for (const [name, value] of Object.entries(COPILOT_HEADERS)) {
      if (!headers.has(name)) headers.set(name, value);
    }
  }

  if (auth.apiKey) {
    const useApiKeyHeader = Boolean(incomingHeaders["x-api-key"]) || providerId === "anthropic";
    if (useApiKeyHeader) headers.set("x-api-key", auth.apiKey);
    else headers.set("authorization", `Bearer ${auth.apiKey}`);
  }
  return headers;
}

function copySafeQuery(source, destination) {
  for (const [name, value] of source.searchParams) {
    if (!/^(?:key|api_?key|access_?token|token)$/i.test(name)) {
      destination.searchParams.append(name, value);
    }
  }
}

function isSensitiveHeader(name) {
  return /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(name);
}

function isHopByHopHeader(name) {
  return /^(?:connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|host|content-length)$/i.test(name);
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BrokerError(413, "Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class BrokerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
