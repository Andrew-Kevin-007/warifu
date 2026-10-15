// Stand-in for lib/utils/openAIClient (OURS). The model call is the one stubbed decision input: a deterministic,
// SIMULATED validator (no key, no paid call; AGENTS.md §0.12) answers in the JSON shape the vendored prompt asks for.
import { edge } from "./edges";

interface Part {
  readonly type: string;
  readonly text?: string;
  readonly image_url?: { readonly url: string };
}

export const openai = {
  chat: {
    completions: {
      async create(args: { messages: Array<{ content: Part[] }> }): Promise<{ choices: Array<{ message: { content: string } }> }> {
        const parts = args.messages[0]?.content ?? [];
        const prompt = parts.find((p) => p.type === "text")?.text ?? "";
        const url = parts.find((p) => p.type === "image_url")?.image_url?.url ?? "";
        const b64 = url.slice(url.indexOf("base64,") + "base64,".length);
        const uploaded = Buffer.from(b64, "base64").toString("utf8");
        edge.prompts.push(prompt);
        if (edge.validator === null) throw new Error("B0 stub: no validator configured");
        return { choices: [{ message: { content: JSON.stringify(edge.validator(prompt, uploaded)) } }] };
      },
    },
  },
};
