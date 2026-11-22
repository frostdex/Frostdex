const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const apiBaseUrl = (process.env.FROSTWAVE_API_URL || "").replace(/\/+$/, "");

if (apiBaseUrl) {
  const parsed = new URL(apiBaseUrl);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("FROSTWAVE_API_URL must use HTTPS outside localhost.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("FROSTWAVE_API_URL must be an origin, without a path, query, or fragment.");
  }
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const filename of ["index.html", "app.js", "styles.css"]) {
  fs.copyFileSync(path.join(root, filename), path.join(output, filename));
}
fs.writeFileSync(
  path.join(output, "config.js"),
  `window.FROSTWAVE_CONFIG = Object.freeze({ apiBaseUrl: ${JSON.stringify(apiBaseUrl)} });\n`,
);
console.log(`Built static site in dist${apiBaseUrl ? ` for ${apiBaseUrl}` : " (same-origin API)"}.`);
