// `?raw` imports, for tests that need to read a repo file as text.
//
// The backend suite runs inside workerd, whose filesystem is sandboxed — a
// readFileSync of anything outside the worker's own scope fails at runtime, so
// config.test.ts cannot reach the repo-root wrangler.toml that way. Vite's
// `?raw` suffix inlines the file's contents as a string literal during the
// transform, so by the time the code reaches workerd there is no file read
// left to perform.
//
// Declared here rather than by referencing vite/client (which the frontend
// uses) because that pulls in a browser `ImportMeta` shape that conflicts with
// the Workers one already supplied by @cloudflare/workers-types.
declare module "*?raw" {
  const contents: string;
  export default contents;
}
