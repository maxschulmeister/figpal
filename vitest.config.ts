import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["{shared,plugin,web}/src/**/*.test.ts", "local/*.test.ts"] },
});
