#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const configDir = process.env.PI_HOST_AGENT_DIR || join(homedir(), ".pi", "agent");
const packageRoot = process.env.PI_CODING_AGENT_PACKAGE_ROOT || findGlobalPackageRoot();
const moduleUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;
const { ModelRuntime } = await import(moduleUrl);

const runtime = await ModelRuntime.create({
  authPath: join(configDir, "auth.json"),
  modelsPath: join(configDir, "models.json"),
  modelsStorePath: join(configDir, "models-store.json"),
  allowModelNetwork: false,
});

const allowedProviders = new Set(
  runtime.getProviders()
    .map((provider) => provider.id)
    .filter((providerId) => runtime.hasConfiguredAuth(providerId)),
);

if (allowedProviders.size === 0) {
  throw new Error(`No authenticated Pi providers found under ${configDir}`);
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

  const authResult = await runtime.getAuth(providerId, { minOAuthValidityMs: 5 * 60 * 1000 });
  if (!authResult) throw new BrokerError(502, `Authentication unavailable for provider '${providerId}'`);

  const provider = runtime.getProvider(providerId);
  const baseUrl = authResult.auth.baseUrl || provider?.baseUrl;
  if (!baseUrl) throw new BrokerError(502, `Provider '${providerId}' has no base URL`);

  const upstream = new URL(upstreamPath.replace(/^\//, ""), ensureTrailingSlash(baseUrl));
  copySafeQuery(incoming, upstream);

  const headers = createUpstreamHeaders(request.headers, authResult.auth);
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

function findGlobalPackageRoot() {
  const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Unable to locate global Pi package: ${result.stderr.trim()}`);
  }
  return join(result.stdout.trim(), "@earendil-works", "pi-coding-agent");
}

function isAllowedModelPath(method, path) {
  const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (method === "GET") return /^\/(?:v1\/)?models$/.test(normalized);
  if (method !== "POST") return false;
  return /^\/(?:v1\/)?(?:chat\/completions|responses|messages|messages\/count_tokens)$/.test(normalized);
}

function createUpstreamHeaders(incomingHeaders, auth) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (!value || isSensitiveHeader(name) || isHopByHopHeader(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  if (auth.apiKey) {
    if (incomingHeaders["x-api-key"]) headers.set("x-api-key", auth.apiKey);
    else headers.set("authorization", `Bearer ${auth.apiKey}`);
  }
  for (const [name, value] of Object.entries(auth.headers || {})) headers.set(name, value);
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
