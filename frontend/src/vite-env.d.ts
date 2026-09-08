/// <reference types="vite/client" />

// Vite's ambient client types. Standard scaffolding this project never had,
// added when a test needed to read index.html as text.
//
// The alternative was @types/node, and it is the wrong tool here: this is a
// browser app, and pulling in Node's globals would make `process`, `Buffer`
// and `fs` typecheck inside application code, where every one of them is a
// mistake that would only surface at runtime in the bundle. Vite's `?raw`
// import does the same job through the bundler that is already there, and
// works identically under `vite build` and under Vitest.
