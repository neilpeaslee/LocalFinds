import { defineConfig } from "drizzle-kit";
import { dbPath } from "./src/paths";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  dbCredentials: { url: dbPath() },
});
