import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("companion extension is limited to JobDeck and BOSS Zhipin origins", () => {
  const manifest = JSON.parse(read("../extension/manifest.json"));
  const allOrigins = [...manifest.host_permissions, ...manifest.optional_host_permissions];

  assert.deepEqual(manifest.optional_host_permissions, [
    "https://zhipin.com/*",
    "https://*.zhipin.com/*"
  ]);
  assert.ok(manifest.host_permissions.includes("https://job.aibro.vip/*"));
  assert.ok(!allOrigins.includes("http://*/*"));
  assert.ok(!allOrigins.includes("https://*/*"));
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /https:\/\/\*|wss:\/\/\*/);

  const options = read("../extension/options.js");
  const sidepanel = read("../extension/sidepanel.js");
  assert.match(options, /api\.origin !== "https:\/\/job\.aibro\.vip"/);
  assert.match(options, /bridge\.pathname !== "\/extension" \|\| bridge\.search \|\| bridge\.hash/);
  assert.match(sidepanel, /candidate\.hostname === "zhipin\.com"/);
  assert.match(sidepanel, /candidate\.hostname\.endsWith\("\.zhipin\.com"\)/);
});

test("production reverse proxy sends baseline browser security headers", () => {
  const caddyfile = read("../deploy/Caddyfile");

  assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
  assert.match(caddyfile, /X-Content-Type-Options "nosniff"/);
  assert.match(caddyfile, /X-Frame-Options "DENY"/);
  assert.match(caddyfile, /Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.match(caddyfile, /Content-Security-Policy "[^"]*frame-ancestors 'none'/);
});

test("WebSocket authentication has no URL query-token compatibility path", () => {
  for (const source of [read("../server/bridge.mjs"), read("../server/tenant-runtime.mjs")]) {
    assert.doesNotMatch(source, /searchParams\.get\(["']token["']\)/);
    assert.match(source, /protocolTokens\.length === 1/);
    assert.match(source, /protocols\.includes\("jobdeck"\)/);
  }
});
