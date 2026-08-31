import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const hostSecret = "host-only-opencode-secret";
const guestSecret = "guest-dummy-secret";
const configDir = await mkdtemp(join(tmpdir(), "agent-vm-opencode-broker-test."));
let receivedAuthorization = "";
let receivedPath = "";

const upstream = createServer(async (request, response) => {
  receivedAuthorization = request.headers.authorization || "";
  receivedPath = request.url || "";
  for await (const _chunk of request) {
    // Drain the request body.
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamAddress = upstream.address();
assert(upstreamAddress && typeof upstreamAddress !== "string");

const authPath = join(configDir, "auth.json");
const configPath = join(configDir, "opencode.json");
await writeFile(authPath, JSON.stringify({
  test: { type: "api", key: hostSecret },
}));
await writeFile(configPath, JSON.stringify({
  provider: {
    test: {
      options: {
        baseURL: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      },
    },
  },
}));

const broker = spawn(process.execPath, [resolve("opencode-credential-broker.mjs")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    OPENCODE_AUTH_PATH: authPath,
    OPENCODE_CONFIG_PATH: configPath,
    OPENCODE_MODELS_PATH: join(configDir, "missing-models.json"),
  },
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  const readiness = await readLine(broker.stdout);
  const { port, providers } = JSON.parse(readiness);
  assert.deepEqual(providers, ["test"]);

  const forbidden = await fetch(`http://127.0.0.1:${port}/provider/test/admin`, {
    method: "POST",
  });
  assert.equal(forbidden.status, 403);

  const proxied = await fetch(`http://127.0.0.1:${port}/provider/test/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${guestSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });
  assert.equal(proxied.status, 200);
  assert.equal(receivedAuthorization, `Bearer ${hostSecret}`);
  assert.equal(receivedPath, "/v1/chat/completions");
  assert(!JSON.stringify(await proxied.json()).includes(hostSecret));
  process.stdout.write("opencode broker smoke test passed\n");
} finally {
  if (broker.exitCode === null) {
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
  }
  upstream.close();
  await rm(configDir, { recursive: true, force: true });
}

async function readLine(stream) {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline);
  }
  throw new Error("Broker exited before reporting readiness");
}
