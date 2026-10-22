import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(".");
const temp = mkdtempSync(join(tmpdir(), "agent-vm-launcher-test."));
const home = join(temp, "home");
const bin = join(temp, "bin");
const project = join(temp, "project");
const config = join(home, ".config/opencode/opencode.json");
const calls = join(temp, "calls");
const yaml = join(temp, "created.yaml");
for (const dir of [bin, project, join(home, ".config/opencode")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(bin, "limactl"), `#!/bin/bash
printf '%s\\n' "$1" >> "$TEST_CALLS"
case "$1" in
  list) exit 0 ;;
  create) cp "\${@: -1}" "$TEST_YAML"; exit 23 ;;
  *) echo "Unexpected VM operation" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
symlinkSync(join(root, "agent.sh"), join(bin, "agent-vm"));
const env = { ...process.env, HOME: home, XDG_CACHE_HOME: join(temp, "cache"), XDG_DATA_HOME: join(home, ".local/share"), PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: calls, TEST_YAML: yaml };
function run(args = [], cwd = project) {
  rmSync(calls, { force: true });
  rmSync(yaml, { force: true });
  return spawnSync("bash", [join(bin, "agent-vm"), ...args], { cwd, env, encoding: "utf8" });
}
function created(result) {
  assert.equal(result.status, 1, result.stderr); // mocked create deliberately stops before boot
  assert.match(result.stderr, /failed to create/);
  assert(existsSync(yaml), result.stderr);
  assert(!readFileSync(calls, "utf8").includes("start"));
}
try {
  writeFileSync(config, '{"provider": {},\n}');
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid JSON object/);
  assert(result.stderr.includes(config));
  assert(!existsSync(yaml));
  assert(!existsSync(env.XDG_CACHE_HOME));

  const secret = "host-only-test-secret";
  writeFileSync(config, JSON.stringify({ provider: { test: { options: { apiKey: secret, baseURL: "https://example.com/v1" } } } }));
  result = run();
  created(result);
  assert(result.stdout.includes(join(root, "templates/lima.yaml.template")));
  assert(readFileSync(yaml, "utf8").includes(project));
  const cache = join(env.XDG_CACHE_HOME, "agent-vm/opencode/agent-project/opencode.json");
  const sanitized = readFileSync(cache, "utf8");
  assert(!sanitized.includes(secret));
  assert.equal(JSON.parse(sanitized).provider.test.options.apiKey, "agent-vm-broker");

  // Semantic jq failures must also stop before creation and preserve the last good cache.
  const auth = join(home, ".local/share/opencode/auth.json");
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(auth, JSON.stringify({ test: { type: "api", key: secret } }));
  writeFileSync(config, '{"provider": []}');
  result = run();
  assert.equal(result.status, 1);
  assert(!existsSync(yaml));
  assert.equal(readFileSync(cache, "utf8"), sanitized);
  rmSync(auth);
  writeFileSync(config, '{}');

  const custom = join(project, "private template.yaml");
  writeFileSync(custom, 'vmType: vz\n# selected-private-template\n# {{PROJECT_PATH}}\n');
  for (const args of [["-t", custom], ["--template", "./private template.yaml"], [`--template=${custom}`]]) {
    created(run(args));
    assert(readFileSync(yaml, "utf8").includes("selected-private-template"));
  }
  created(run(["-t", "./templates/lima.yaml.template"], root));
  created(run(["-t", join(root, "templates/lima-codex.yaml.template")]));
  created(run(["-t", join(root, "templates/lima-docker.yaml.template")]));
  for (const args of [["-t"], ["--template="], ["-t", "./missing.yaml"], ["-t", "docker"]]) {
    result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /template/);
    assert(!existsSync(calls), result.stderr);
  }
  result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--template PATH/);
  assert(!existsSync(calls));
  console.log("launcher smoke test passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
