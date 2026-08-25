import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("web and extension share the exact Quiet UI token contract", () => {
  const webTokens = read("../web/design-tokens.css");
  const extensionTokens = read("../extension/design-tokens.css");
  assert.equal(extensionTokens, webTokens);
  assert.match(webTokens, /--jd-color-accent:/);
  assert.match(webTokens, /--jd-space-4:/);
  assert.match(webTokens, /--jd-focus-ring:/);
});

test("all user interfaces load design tokens before page styles", () => {
  const pages = [
    ["../web/index.html", "styles.css"],
    ["../extension/sidepanel.html", "sidepanel.css"],
    ["../extension/options.html", "options.css"]
  ];

  for (const [page, pageStyles] of pages) {
    const html = read(page);
    assert.ok(html.indexOf("design-tokens.css") >= 0, `${page} must load design tokens`);
    assert.ok(html.indexOf("design-tokens.css") < html.indexOf(pageStyles), `${page} must load tokens first`);
  }
});

test("the normative design specification protects the quiet interface rules", () => {
  const specification = read("../docs/DESIGN_SYSTEM.md");
  assert.match(specification, /每个区块最多一个实心主按钮/);
  assert.match(specification, /Agent 实时任务时间线/);
  assert.match(specification, /禁止模式/);
});

test("the shipped UI follows the Quiet UI hierarchy instead of the old poster style", () => {
  const web = read("../web/styles.css");
  const sidepanel = read("../extension/sidepanel.css");
  const html = read("../web/index.html");

  assert.match(web, /\.masthead h1\s*\{[^}]*var\(--jd-text-xl\)/s);
  assert.match(web, /\.sidebar\s*\{[^}]*background:\s*var\(--surface\)/s);
  assert.match(web, /\.chat-task::before/);
  assert.match(web, /\.chat-task::after/);
  assert.match(sidepanel, /border-radius:\s*var\(--jd-radius-surface\)/);
  assert.doesNotMatch(html, /JOB SEARCH OPERATIONS|FIRST RUN|CURRENT CHROME PAGE|HUMAN APPROVAL/);
  assert.doesNotMatch(web, /border-top:\s*[6-9]px\s+solid/);
});
