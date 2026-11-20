import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const readPackage = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const { version } = await readPackage("package.json");
const { dependencies, license } = await readPackage("mcp-server/package.json");
const shared = "@webmcp-controller/shared";
delete dependencies[shared];

const output = path.join(root, "dist");
await mkdir(output, { recursive: true });
const stage = await mkdtemp(path.join(os.tmpdir(), "foxhand-helper-"));
try {
  const host = path.join(stage, "host.js");
  await build({
    absWorkingDir: root,
    entryPoints: ["mcp-server/src/host.ts"],
    outfile: host,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    alias: { [shared]: path.join(root, "shared/src/protocol.ts") },
    banner: { js: "#!/usr/bin/env node" },
  });
  await chmod(host, 0o755);
  await writeFile(path.join(stage, "package.json"), JSON.stringify({
    name: "@foxhand/helper",
    mcpName: "io.github.hamb1y/foxhand",
    version,
    description: "Native messaging and MCP helper for the Foxhand Firefox add-on",
    license,
    type: "module",
    repository: { type: "git", url: "git+https://github.com/hamb1y/foxhand.git" },
    homepage: "https://foxhand.pages.dev/",
    engines: { node: ">=22" },
    bin: { "foxhand-helper": "host.js" },
    files: ["host.js"],
    dependencies,
    publishConfig: { access: "public" },
  }, null, 2) + "\n");
  await copyFile(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  await writeFile(path.join(stage, "README.md"), `# Foxhand helper

Native messaging helper for the [Foxhand Firefox add-on](https://foxhand.pages.dev/).

\`\`\`sh
npm install -g @foxhand/helper
foxhand-helper install
\`\`\`

In Windows PowerShell, use \`npm.cmd\` and \`foxhand-helper.cmd\` instead.
Restart Firefox, then open Foxhand to connect your MCP client.
Run \`foxhand-helper uninstall\` before removing the npm package.

Stdio-only MCP clients can launch \`npx -y @foxhand/helper mcp\`. Set
\`FOXHAND_TOKEN\` to the token from Foxhand Settings (without \`Bearer\`).
If you changed the port, also set \`FOXHAND_URL\` to the localhost MCP URL.
`);
  execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--pack-destination", output], {
    cwd: stage,
    stdio: "inherit",
  });
} finally {
  await rm(stage, { recursive: true, force: true });
}
