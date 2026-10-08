// Vercel serverless entry point.
// Vercel only detects functions inside /api, so this thin wrapper re-exports
// the Express app defined in ../index.js. Routing (/(.*) -> /api) is configured
// in vercel.json, and Vercel forwards the original request path (e.g. /graphql)
// to the app unchanged.
// Local development still runs `node index.js` directly (see package.json scripts).
import app from "../index.js";

export default app;
