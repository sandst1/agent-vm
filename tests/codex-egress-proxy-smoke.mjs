import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";

const proxy = spawn(
  process.execPath,
  [
    resolve("codex-egress-proxy.mjs"),
    "--allow-domain", "example.com",
    "--allow-domain", "localhost",
  ],
  {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "inherit"],
  },
);

try {
  const readiness = JSON.parse(await readLine(proxy.stdout));
  assert(Number.isInteger(readiness.port));
  assert(readiness.allowedDomains.includes("registry.npmjs.org"));
  assert(readiness.allowedDomains.includes("example.com"));

  assert.match(
    await proxyRequest(readiness.port, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n"),
    /^HTTP\/1\.1 200 /,
  );
  assert.match(
    await proxyRequest(readiness.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"),
    /^HTTP\/1\.1 200 /,
  );
  assert.match(
    await proxyRequest(readiness.port, "CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n"),
    /^HTTP\/1\.1 403 /,
  );
  assert.match(
    await proxyRequest(readiness.port, "CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n\r\n"),
    /^HTTP\/1\.1 403 /,
  );
  assert.match(
    await proxyRequest(readiness.port, "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n"),
    /^HTTP\/1\.1 403 /,
  );
  assert.match(
    await proxyRequest(readiness.port, "CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n\r\n"),
    /^HTTP\/1\.1 403 /,
  );
  assert.match(
    await proxyRequest(readiness.port, "CONNECT registry.npmjs.org:80 HTTP/1.1\r\nHost: registry.npmjs.org:80\r\n\r\n"),
    /^HTTP\/1\.1 403 /,
  );
  assert.match(
    await proxyRequest(readiness.port, "GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n"),
    /^HTTP\/1\.1 405 /,
  );

  process.stdout.write("codex egress proxy smoke test passed\n");
} finally {
  if (proxy.exitCode === null) {
    proxy.kill("SIGTERM");
    await once(proxy, "exit").catch(() => undefined);
  }
}

async function proxyRequest(port, request) {
  const socket = connect(port, "127.0.0.1");
  socket.setEncoding("utf8");
  await once(socket, "connect");
  socket.write(request);
  let response = "";
  for await (const chunk of socket) {
    response += chunk;
    if (response.includes("\r\n\r\n")) {
      socket.destroy();
      return response;
    }
  }
  return response;
}

async function readLine(stream) {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline);
  }
  throw new Error("Egress proxy exited before reporting readiness");
}
