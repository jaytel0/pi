import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const baseUrl = process.env.MOCK_OPENAI_BASE_URL;
	if (!baseUrl) throw new Error("MOCK_OPENAI_BASE_URL is required");
	pi.registerProvider("openai", { baseUrl });
}
