const { handleApiRequest } = require("../vercel-api");

module.exports = async function handler(req, res) {
  try {
    const handled = await handleApiRequest(req, res);
    if (handled === false) return res.status(404).json({ error: "Not found." });
    return handled;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request couldn't be completed.";
    const status = /isn't allowed|origin isn't allowed/.test(message)
      ? 403
      : /Connect your wallet|expired|belongs to another wallet/.test(message)
        ? 401
        : /FAL_KEY|FROSTWAVE_ALLOWED_WALLET/.test(message)
          ? 503
          : /timed out|TimeoutError/i.test(message)
            ? 504
            : /fal\.ai returned|fal\.ai didn't return|unexpected (?:queue|media) URL|fetch failed/i.test(message)
              ? 502
              : 400;
    return res.status(status).json({ error: message });
  }
}
