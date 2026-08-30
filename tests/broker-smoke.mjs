import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const hostSecret = "host-only-test-secret";
const guestSecret = "guest-dummy-secret";
const packageRoot = join(
  spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim(),
  "@earendil-works",
  "pi-coding-agent",
);
const configDir = await mkdtemp(join(tmpdir(), "agent-vm-broker-test."));
let receivedAuthorization = "";

const upstream = createServer(async (request, response) => {
  receivedAuthorization = request.headers.authorization || "";
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

await writeFile(join(configDir, "auth.json"), JSON.stringify({
  test: { type: "api_key", key: hostSecret },
}));
await writeFile(join(configDir, "models.json"), JSON.stringify({
  providers: {
    test: {
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      api: "openai-completions",
      models: [{ id: "test-model" }],
    },
  },
}));

const broker = spawn(process.execPath, [resolve("pi-credential-broker.mjs")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PI_HOST_AGENT_DIR: configDir,
    PI_CODING_AGENT_PACKAGE_ROOT: packageRoot,
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
  assert(!JSON.stringify(await proxied.json()).includes(hostSecret));
  process.stdout.write("broker smoke test passed\n");
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
