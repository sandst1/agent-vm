#!/usr/bin/env node

import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { connect, isIP } from "node:net";

const BUILTIN_RULES = [
  "api.openai.com",
  "auth.openai.com",
  "openai.com",
  "*.openai.com",
  "chatgpt.com",
  "*.chatgpt.com",
  "registry.npmjs.org",
  "auth.docker.io",
  "registry-1.docker.io",
  "production.cloudflare.docker.com",
  "production.cloudfront.docker.com",
];

const extraDomains = parseExtraDomains(process.argv.slice(2));
const rules = [...new Set([...BUILTIN_RULES, ...extraDomains])];
const sockets = new Set();

const server = createServer((_request, response) => {
  response.writeHead(405, {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
  response.end("Only HTTPS CONNECT tunnels are supported.\n");
});

server.on("connect", (request, clientSocket, head) => {
  sockets.add(clientSocket);
  clientSocket.once("close", () => sockets.delete(clientSocket));
  void handleConnect(request, clientSocket, head);
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Egress proxy did not bind a TCP port");
  }
  process.stdout.write(`${JSON.stringify({
    port: address.port,
    allowedDomains: rules,
  })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, shutdown);
}

async function handleConnect(request, clientSocket, head) {
  try {
    const { hostname, port } = parseAuthority(request.url || "");
    if (port !== 443) throw new ProxyError(403, "Only destination port 443 is allowed");
    if (isIP(hostname)) throw new ProxyError(403, "IP-literal destinations are not allowed");
    if (!matchesRules(hostname, rules)) throw new ProxyError(403, "Destination is not allowed");

    const records = await lookup(hostname, { all: true, verbatim: true });
    const publicRecords = records.filter(({ address }) => isPublicAddress(address));
    if (publicRecords.length === 0) {
      throw new ProxyError(403, "Destination did not resolve to a public address");
    }

    const upstream = await connectFirst(publicRecords, port);
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("error", () => clientSocket.destroy());
    clientSocket.once("error", () => upstream.destroy());

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  } catch (error) {
    const status = error instanceof ProxyError ? error.status : 502;
    const message = error instanceof Error ? error.message : String(error);
    clientSocket.end(
      `HTTP/1.1 ${status} ${statusText(status)}\r\n`
      + "Content-Type: text/plain; charset=utf-8\r\n"
      + "Connection: close\r\n"
      + `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`
      + message,
    );
  }
}

function parseExtraDomains(args) {
  const domains = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value;
    if (arg === "--allow-domain") {
      value = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--allow-domain=")) {
      value = arg.slice("--allow-domain=".length);
    } else {
      throw new Error(`Unknown egress proxy argument: ${arg}`);
    }
    domains.push(validateExtraDomain(value));
  }
  return domains;
}

function validateExtraDomain(value) {
  const hostname = String(value || "").toLowerCase().replace(/\.$/, "");
  if (
    !hostname
    || hostname.length > 253
    || isIP(hostname)
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
  ) {
    throw new Error(`Invalid --allow-domain value: ${value || "(empty)"}`);
  }
  return hostname;
}

function parseAuthority(authority) {
  let parsed;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw new ProxyError(400, "Malformed CONNECT destination");
  }
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || !parsed.hostname
  ) {
    throw new ProxyError(400, "Malformed CONNECT destination");
  }
  return {
    hostname: parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, ""),
    port: Number(parsed.port || 80),
  };
}

function matchesRules(hostname, allowedRules) {
  return allowedRules.some((rule) => (
    rule.startsWith("*.")
      ? hostname.endsWith(rule.slice(1)) && hostname !== rule.slice(2)
      : hostname === rule
  ));
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

function connectFirst(records, port) {
  return new Promise((resolve, reject) => {
    let index = 0;
    let lastError;
    let settled = false;
    const tryNext = () => {
      if (settled) return;
      if (index >= records.length) {
        settled = true;
        reject(lastError || new Error("No reachable public address"));
        return;
      }
      const record = records[index];
      index += 1;
      const socket = connect({
        host: record.address,
        family: record.family,
        port,
      });
      socket.setTimeout(15_000);
      socket.once("connect", () => {
        settled = true;
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once("timeout", () => {
        lastError = new Error("Timed out connecting to destination");
        socket.destroy();
      });
      socket.once("error", (error) => {
        lastError = error;
      });
      socket.once("close", () => {
        tryNext();
      });
    };
    tryNext();
  });
}

function statusText(status) {
  if (status === 400) return "Bad Request";
  if (status === 403) return "Forbidden";
  return "Bad Gateway";
}

function shutdown() {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
}

class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
