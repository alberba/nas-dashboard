// ESLint requires the JS compiler API; TypeScript 7 ships a native compiler.
// Keep the app on TS 7 and route only this lint process to the latest TS 6 API.
import { createRequire, registerHooks } from "node:module";
const api = createRequire(import.meta.url).resolve("typescript-api");
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "typescript" ? api : specifier, context);
  },
});
