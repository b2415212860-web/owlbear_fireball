import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

const dist = new URL("../dist/", import.meta.url);
const base = "/fireball/";
const pages = ["index.html", "button.html", "target.html"];

function deployedFile(url) {
  assert.ok(url.startsWith(base), `URL escapes the deployment prefix: ${url}`);
  assert.ok(!url.startsWith(`${base}fireball/`), `Duplicated prefix: ${url}`);
  return new URL(url.slice(base.length), dist);
}

async function builtScripts() {
  const assets = new URL("assets/", dist);
  const names = await readdir(assets);
  return Promise.all(names.filter((name) => name.endsWith(".js")).map(async (name) => {
    const file = new URL(name, assets);
    return { file, source: await readFile(file, "utf8") };
  }));
}

describe("production deployment under /fireball/", () => {
  it("loads the manifest background and icon from the subdirectory", async () => {
    const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
    assert.equal(manifest.background_url, "/fireball/index.html");
    assert.equal(manifest.icon, "/fireball/icon.svg");
    await access(deployedFile(manifest.background_url));
    await access(deployedFile(manifest.icon));
  });

  for (const page of pages) {
    it(`resolves every script and stylesheet referenced by ${page}`, async () => {
      const html = await readFile(deployedFile(`${base}${page}`), "utf8");
      const references = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)];
      assert.ok(references.length > 0, `${page} has no bundled resources`);
      for (const [, url] of references) {
        assert.ok(!url.endsWith(".ts"), `Uncompiled source reference: ${url}`);
        await access(deployedFile(url));
      }
    });
  }

  it("opens the Owlbear button and targeting pages using the deployment prefix", async () => {
    const scripts = await builtScripts();
    const combined = scripts.map(({ source }) => source).join("\n");
    assert.ok(combined.includes("/fireball/button.html"), "Missing subpath button URL");
    assert.ok(combined.includes("/fireball/target.html"), "Missing subpath targeting URL");
    assert.doesNotMatch(combined, /["'`]\/(?:index\.html|button\.html|target\.html|icon\.svg|assets\/)/);
  });

  it("keeps imported code chunks resolvable within the deployed assets", async () => {
    const scripts = await builtScripts();
    let imports = 0;
    for (const { file, source } of scripts) {
      for (const [, relative] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["'](\.[^"']+)["']/g)) {
        const target = new URL(relative, file);
        assert.ok(target.href.startsWith(dist.href), `Import escapes dist: ${relative}`);
        await access(target);
        imports += 1;
      }
    }
    assert.ok(imports > 0, "Expected the multi-page build to include shared or dynamic chunks");
  });
});
