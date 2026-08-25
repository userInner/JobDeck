import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("release version is aligned across app, extension, lockfile, and download link", () => {
  const packageJson = JSON.parse(read("../package.json"));
  const packageLock = JSON.parse(read("../package-lock.json"));
  const manifest = JSON.parse(read("../extension/manifest.json"));
  const html = read("../web/index.html");
  const server = read("../server/index.mjs");
  const filename = `JobDeck-Chrome-Extension-v${packageJson.version}.zip`;

  assert.equal(packageJson.version, "0.17.0");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(manifest.version, packageJson.version);
  assert.match(server, new RegExp(`version: "${packageJson.version.replaceAll(".", "\\.")}"`));
  assert.match(html, new RegExp(`href="/downloads/${filename.replaceAll(".", "\\.")}"`));
  assert.match(html, new RegExp(`download="${filename.replaceAll(".", "\\.")}"`));
});

test("production image packages the companion extension into the static downloads directory", () => {
  const dockerfile = read("../Dockerfile");

  assert.match(dockerfile, /FROM node:22-alpine AS extension-package/);
  assert.match(dockerfile, /RUN sh scripts\/package-extension\.sh/);
  assert.match(dockerfile, /cp dist\/JobDeck-Chrome-Extension-v\*\.zip \/extension-downloads\//);
  assert.match(
    dockerfile,
    /COPY --from=extension-package \/extension-downloads \.\/web\/downloads/,
  );
});
