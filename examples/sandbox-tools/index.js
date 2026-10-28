/**
 * Sandbox Tools Example (Programmatic Tool Calling & Security Policy)
 *
 * Demonstrates MCP "code mode" (`run_tool_script`) inside a `WorkerSandbox`:
 * 1. The model writes a single JavaScript script that calls `logging_getLogs` and
 *    `ticketing_createIssue` via auto-generated JSDoc stubs.
 * 2. Raw log entries are filtered and deduplicated inside the sandbox so intermediate
 *    payloads never bloat the model's context window.
 * 3. Every tool call made by the script is brokered back through the host with
 *    `origin: 'sandbox'` and checked by `createApprovalPolicy` (`level: 'sensitive'`).
 *
 * Run from repository root:
 *   node --env-file=.env examples/sandbox-tools/index.js
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  Agent,
  LLMService,
  WorkerSandbox,
  defineTool,
  generateToolStubs,
  composePolicy,
  strictPolicy,
  createApprovalPolicy,
} from '../../index.js';

// Define two tools (works identically for local tools or MCP server tools)
const getLogsTool = defineTool(
  {
    name: 'logging_getLogs',
    description: 'Fetch recent application log entries by level.',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', description: 'Log level filter, e.g. "error" or "info"' },
      },
      required: ['level'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              timestamp: { type: 'string' },
              level: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['timestamp', 'level', 'message'],
          },
        },
      },
      required: ['entries'],
    },
  },
  async ({ level }) => {
    const allLogs = [
      { timestamp: '2026-10-28T12:00:01Z', level: 'error', message: 'Database connection timeout' },
      { timestamp: '2026-10-28T12:00:05Z', level: 'error', message: 'Database connection timeout' },
      { timestamp: '2026-10-28T12:01:10Z', level: 'info', message: 'Healthcheck OK' },
      { timestamp: '2026-10-28T12:02:00Z', level: 'error', message: 'Payment gateway 502' },
    ];
    return { entries: allLogs.filter((l) => l.level === level) };
  }
);

const createdTickets = [];
const createIssueTool = defineTool(
  {
    name: 'ticketing_createIssue',
    description: 'Create an issue ticket for a unique error.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        occurrences: { type: 'number' },
      },
      required: ['title', 'occurrences'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string' },
        title: { type: 'string' },
        occurrences: { type: 'number' },
      },
      required: ['issueId', 'title', 'occurrences'],
    },
    sensitive: true, // Flagged as sensitive so our policy inspects/approves each call
  },
  async ({ title, occurrences }) => {
    const ticket = { issueId: `ISS-${createdTickets.length + 1}`, title, occurrences };
    createdTickets.push(ticket);
    return ticket;
  }
);

const llm = new LLMService({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
});

const rl = readline.createInterface({ input, output });

const policy = composePolicy(
  strictPolicy(),
  createApprovalPolicy({
    level: 'sensitive',
    treatSandboxAsSensitive: false, // Prompt only when the tool itself is marked sensitive
    confirm: async (call) => {
      const answer = await rl.question(
        `\n[Policy Confirm] Allow ${call.origin} call to '${call.name}' with args ${JSON.stringify(call.args)}? (y/n): `
      );
      const approved = answer.trim().toLowerCase().startsWith('y');
      return approved
        ? { allow: true }
        : { allow: false, reason: `User denied '${call.name}'.` };
    },
  })
);

const agent = new Agent(llm, {
  name: 'SandboxDemoAgent',
  codeMode: true,
  sandbox: new WorkerSandbox({ timeoutMS: 60000, memoryMB: 64 }),
  policy,
  tools: [getLogsTool, createIssueTool],
});

// Provide the generated JSDoc tool stubs in the system prompt so the model knows exact types
const stubsPreview = generateToolStubs(agent.toolLoader.getToolDeclarations());
agent.addInput({
  role: 'system',
  content: [
    'Use the `run_tool_script` tool to solve the user task in a single sandboxed JavaScript script.',
    'Do not call `logging_getLogs` or `ticketing_createIssue` directly; call them inside `run_tool_script`.',
    'Available sandbox functions:\n```js\n' + stubsPreview + '\n```',
  ].join('\n\n'),
});

agent.addInput({
  role: 'user',
  content: 'Fetch all "error" logs, deduplicate them by message in the sandbox, file one ticket per unique error with its occurrence count, and log a one-line summary.',
});

const history = await agent.run();
rl.close();

console.log('\n=== Created Tickets ===');
console.log(createdTickets);

console.log('\n=== Sandbox Tool Result in Context ===');
const toolResults = agent.context.getMessages().filter((m) => m.type === 'function_call_output');
for (const tr of toolResults) {
  console.log(tr.output);
}

console.log('\n=== Final Agent Response ===');
console.log(history[history.length - 1].output);
