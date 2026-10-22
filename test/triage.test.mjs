// Offline tests: no network, no model calls, no opencode needed. Node >= 22.6.
// Run: npm test   (uses --experimental-strip-types to load the TypeScript directly)
import test from "node:test"
import assert from "node:assert/strict"

process.env.HOME = "/home/tester"
delete process.env.XDG_STATE_HOME
const { triage } = await import("../plugin/lib/triage.ts")
const { defaultConfig } = await import("../plugin/lib/config.ts")

const cfg = defaultConfig()
const run = (cmd) => triage("bash", { command: cmd }, cfg)

test("default config is fully populated and has no hard-coded home directory", () => {
  const text = JSON.stringify(cfg)
  assert.ok(cfg.tiers && cfg.chains && cfg.board && cfg.paths)
  assert.ok(text.includes("/home/tester/.local/state/ocrev"), "paths follow $HOME")
  assert.ok(!text.includes("/home/" + "dev"), "no author-specific paths in defaults")
})

test("state paths are derived from the environment", () => {
  assert.match(cfg.paths.stateDir, /ocrev$/)
  assert.ok(cfg.paths.killFiles.some((f) => f.endsWith("/OFF")))
})

test("harmless commands are rated safe (no model call needed)", () => {
  for (const c of ["ls -la", "echo hello", "git status", "cat README.md"]) {
    assert.equal(run(c).risk, "safe", c)
  }
})

test("host-rule destroyers are fatal", () => {
  assert.equal(run("truncate -s 0 data.csv").tier, "fatal")
})

test("category-wide SQL mutation is not rated safe", () => {
  const r = run(`psql -c "UPDATE accounts SET kind='primary' WHERE kind='secondary'"`)
  assert.notEqual(r.risk, "safe")
})

test("unbounded recursive search over the filesystem root is not rated safe", () => {
  assert.notEqual(run("grep -r password /").risk, "safe")
})

test("secret-shaped strings are redacted from the summary sent to reviewers", () => {
  const fake = "sk-" + "Zq8".repeat(14) // built at runtime: not a real key
  const r = run(`curl -H 'Authorization: Bearer ${fake}' https://example.com/api`)
  assert.ok(!r.summary.includes(fake), "token must not appear in the reviewer summary")
})
