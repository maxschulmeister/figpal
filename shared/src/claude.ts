export const BUNDLED_CLAUDE_VERSION = "2.1.280";
export const CLAUDE_CONFIG_ROUTE = "/api/claude";

export type ClaudeIdentity = { deviceId: string; accountUuid: string };
export type ClaudeConfig = { version: string; identity?: ClaudeIdentity };

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isClaudeIdentity(value: unknown): value is ClaudeIdentity {
	return isObject(value) && typeof value.deviceId === "string" && /^[0-9a-f]{64}$/u.test(value.deviceId) &&
		typeof value.accountUuid === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.accountUuid);
}

export function isClaudeVersion(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value);
}
