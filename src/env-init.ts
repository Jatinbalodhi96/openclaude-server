// Configure environment variables before openclaude SDK is imported.
// This prevents Anthropic prompt caching / scope: "global" errors caused by tool definitions.
process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "true";
process.env.DISABLE_PROMPT_CACHING = "true";
