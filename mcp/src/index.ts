import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { makeRedactor } from "./security.js";

async function main(): Promise<void> {
  const bundle = createServer();
  const shutdownForSignal = async () => {
    await bundle.service.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdownForSignal());
  process.once("SIGTERM", () => void shutdownForSignal());
  process.stdin.once("end", () => void shutdownForSignal());
  process.once("exit", () => { void bundle.service.shutdown(); });
  await bundle.server.connect(new StdioServerTransport());
}

main().catch((error) => {
  const redact = makeRedactor(process.env);
  process.stderr.write(`clipper-cowboy-mcp fatal: ${redact(error)}\n`);
  process.exit(1);
});
