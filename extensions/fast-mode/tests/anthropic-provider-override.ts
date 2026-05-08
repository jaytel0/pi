import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const baseUrl = process.env.MOCK_ANTHROPIC_BASE_URL;
	if (!baseUrl) throw new Error("MOCK_ANTHROPIC_BASE_URL is required");
	pi.registerProvider("anthropic", {
		baseUrl,
		apiKey: "ANTHROPIC_API_KEY",
	});
}
