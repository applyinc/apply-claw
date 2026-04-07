export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startChatAgentGc } = await import("./lib/chat-agent-registry");
    startChatAgentGc();
  }
}
