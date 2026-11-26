const { handleApiRequest } = require("../vercel-api");

module.exports = async function handler(req, res) {
  try {
    const handled = await handleApiRequest(req, res);
    if (handled === false) return res.status(404).json({ error: "Not found." });
    return handled;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request couldn't be completed.";
    const status = /origin isn't allowed/.test(message)
      ? 403
      : /Connect your wallet|expired|belongs to another wallet/.test(message)
        ? 401
        : /HTTP 429|daily.*quota|quota.*exceed|ZeroGPU.*quota|too many requests/i.test(message)
          ? 429
          : /HF_TOKEN|FROSTWAVE_HF_.*SPACE_URL|FROSTWAVE_ALLOWED_WALLETS|HTTP 401|unauthorized/i.test(message)
            ? 503
            : /timed out|TimeoutError/i.test(message)
              ? 504
              : /Hugging Face Space|Hugging Face ZeroGPU|unexpected media URL|fetch failed/i.test(message)
                ? 502
                : 400;
    return res.status(status).json({ error: message });
  }
}
