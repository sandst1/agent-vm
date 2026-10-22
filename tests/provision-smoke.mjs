import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "agent-vm-provision-test."));
const bin = join(temp, "bin");
mkdirSync(bin);
// A Bash-only installer catches regressions to `sh`. The curl failure leaves
// a partial download, which must never be executed or mistaken for success.
writeFileSync(join(bin, "curl"), `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
cat > "$2" <<'INSTALLER'
#!/usr/bin/env bash
args=("$@")
[[ "$1" == --no-modify-path ]] || exit 25
[ "$TEST_FAILURE" != installer ] || exit 23
mkdir -p "$HOME/.opencode/bin"
printf '#!/bin/sh\n[ "$TEST_FAILURE" != binary ] || exit 24\necho test-version\n' > "$HOME/.opencode/bin/opencode"
chmod +x "$HOME/.opencode/bin/opencode"
INSTALLER
[ "$TEST_FAILURE" != download ] || exit 22
`, { mode: 0o755 });

try {
  for (const name of ["lima.yaml.template", "lima-docker.yaml.template", "lima-custom.yaml.template.example"]) {
    const template = readFileSync(join("templates", name), "utf8");
    const userScript = template.split("  - mode: user\n    script: |\n")[1]
      .split("\nprobes:")[0].replace(/^ {6}/gm, "");
    const install = userScript.slice(userScript.indexOf('installer="$(mktemp)"'), userScript.indexOf("\ngit clone"));
    const probe = template.split("probes:\n")[1].split("    script: |\n")[1]
      .split("    hint:")[0].replace(/^ {6}/gm, "");
    for (const [failure, status] of [["download", 22], ["installer", 23], ["binary", 24], ["none", 0]]) {
      const home = join(temp, `${name}-${failure}`);
      const downloads = join(home, "tmp");
      mkdirSync(downloads, { recursive: true });
      const env = { ...process.env, HOME: home, TMPDIR: downloads, PATH: `${bin}:${process.env.PATH}`, TEST_FAILURE: failure };
      const run = (script) => spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
      const result = run(`set -eu\n${install}`);
      assert.equal(result.status, status, `${name}/${failure}: ${result.stderr}`);
      assert.deepEqual(readdirSync(downloads), [], "installer temporary file must be removed");
      if (failure !== "none") continue;
      assert.notEqual(run(probe).status, 0, "incomplete provisioning must fail readiness");
      writeFileSync(join(home, ".agent-vm-user-provisioned"), "");
      assert.notEqual(run(probe).status, 0, "missing loop runner must fail readiness");
      writeFileSync(join(home, ".opencode/bin/opencode-loop"), "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(run(probe).status, 0);
      rmSync(join(home, ".opencode/bin/opencode"));
      assert.notEqual(run(probe).status, 0, "missing OpenCode must fail readiness");
    }
  }
  console.log("provision smoke test passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
