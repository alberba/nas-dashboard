import nextEnv from "@next/env";
import {
  readRuntimeConfig,
  RuntimeConfigError,
} from "../src/lib/runtime-config";

// `@next/env` is CommonJS and its bundle exposes no statically detectable
// named exports, so read the function from the default export.
const { loadEnvConfig } = nextEnv;

// `pnpm start` always runs the built application in production. Force the same
// mode before loading dotenv files so a caller that exported NODE_ENV=test
// still follows the production precedence (and `.env.local` is not skipped).
const runtimeEnv = process.env as Record<string, string | undefined>;
runtimeEnv.NODE_ENV = "production";

// Mirror `next start`: load the project root's dotenv files first; process
// environment values keep precedence over every file.
loadEnvConfig(process.cwd(), false);

try {
  readRuntimeConfig(process.env);
} catch (error) {
  if (error instanceof RuntimeConfigError) {
    console.error(error.message);
  } else {
    // Never echo an unexpected error: it could carry a rejected value.
    console.error("Configuración de arranque no válida");
  }
  process.exitCode = 1;
}
