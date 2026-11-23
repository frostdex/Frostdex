const fs = require("node:fs");
const path = require("node:path");
const { buildSync } = require("esbuild");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const apiBaseUrl = (process.env.FROSTWAVE_API_URL || "").replace(/\/+$/, "");
const walletConnectProjectId = process.env.FROSTWAVE_WALLETCONNECT_PROJECT_ID || "";
const walletConnectChains = (process.env.FROSTWAVE_WALLETCONNECT_CHAINS || "1,10,137,8453,42161")
  .split(",")
  .map((chain) => Number(chain.trim()));

if (process.env.VERCEL && !apiBaseUrl) {
  throw new Error("Set FROSTWAVE_API_URL in Vercel to the public HTTPS origin of your Python backend.");
}
if (process.env.VERCEL && !walletConnectProjectId) {
  throw new Error("Set FROSTWAVE_WALLETCONNECT_PROJECT_ID in Vercel to your public Reown project ID.");
}

if (apiBaseUrl) {
  const parsed = new URL(apiBaseUrl);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("FROSTWAVE_API_URL must use HTTPS outside localhost.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("FROSTWAVE_API_URL must be an origin, without a path, query, or fragment.");
  }
}

if (
  walletConnectChains.length === 0
  || walletConnectChains.some((chain) => !Number.isSafeInteger(chain) || chain < 1)
  || new Set(walletConnectChains).size !== walletConnectChains.length
) {
  throw new Error("FROSTWAVE_WALLETCONNECT_CHAINS must be a comma-separated list of unique positive EVM chain IDs.");
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const filename of ["index.html", "app.js", "styles.css", "audio-upload.css"]) {
  fs.copyFileSync(path.join(root, filename), path.join(output, filename));
}
buildSync({
  entryPoints: [path.join(root, "walletconnect.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  outfile: path.join(output, "walletconnect-provider.js"),
});
fs.writeFileSync(
  path.join(output, "config.js"),
  `window.FROSTWAVE_CONFIG = Object.freeze({ apiBaseUrl: ${JSON.stringify(apiBaseUrl)}, walletConnectProjectId: ${JSON.stringify(walletConnectProjectId)}, walletConnectChains: ${JSON.stringify(walletConnectChains)} });\n`,
);
console.log(`Built static site in dist${apiBaseUrl ? ` for ${apiBaseUrl}` : " (same-origin API)"} with ${walletConnectChains.length} WalletConnect chain(s).`);
