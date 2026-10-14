import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'events';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';
import { assertSandbox } from '../src/tools/sandbox/index.js';
import { isToolResult } from '../src/memory/message.js';

describe('Agent Code Mode & Programmatic Tool Calling (agent-code-mode.test.js)', () => {
    let fakeProvider;

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake', fakeProvider, 'Fake Provider');
    });

    const getUsersTool = {
        name: 'get_users',
        description: 'Returns list of users',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'number' },
            },
        },
        func: async ({ limit = 10 }) => {
            const all = [
                { id: 1, name: 'Alice', active: true },
                { id: 2, name: 'Bob', active: false },
                { id: 3, name: 'Charlie', active: true },
            ];
            return all.slice(0, limit);
        },
    };

    const notifyUserTool = {
        name: 'notify_user',
        description: 'Sends notification to a user',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'number' },
                message: { type: 'string' },
            },
            required: ['userId', 'message'],
        },
        func: async ({ userId, message }) => {
            return { sent: true, userId, message };
        },
    };

    const dangerousTool = {
        name: 'delete_database',
        description: 'Deletes all records',
        parameters: {
            type: 'object',
            properties: {
                confirm: { type: 'boolean' },
            },
        },
        func: async () => ({ deleted: true }),
    };

    test('1. codeMode: true exposes run_tool_script on wire declarations', async () => {
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Hello!'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'code-agent',
            codeMode: true,
            tools: [getUsersTool, notifyUserTool],
        });
        agent.addInput({ role: 'user', content: 'Hi' });

        const history = await agent.run();
        assert.equal(history.length, 1);

        const calls = fakeProvider.getCalls();
        const wireToolNames = calls[0].options.tools.map(t => t.name);

        assert.ok(wireToolNames.includes('run_tool_script'));
        assert.ok(wireToolNames.includes('get_users'));
        assert.ok(wireToolNames.includes('notify_user'));
    });

    test('2. executes run_tool_script, chains multiple tools, and captures summary', async () => {
        // Turn 1: Model calls run_tool_script to filter active users and notify them in a single batch
        const scriptCode = `
            const users = await get_users({ limit: 5 });
            console.log("Fetched " + users.length + " users.");
            const activeUsers = users.filter(u => u.active);
            const notified = [];
            for (const user of activeUsers) {
                const res = await notify_user({ userId: user.id, message: "Welcome " + user.name });
                notified.push(res);
            }
            return { totalNotified: notified.length, recipients: activeUsers.map(u => u.name) };
        `;

        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'run_tool_script',
            args: { code: scriptCode },
            call_id: 'call_script_1',
        }));

        // Turn 2: Model finishes with answer based on script summary
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Successfully notified 2 active users: Alice, Charlie.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'code-runner',
            codeMode: true,
            tools: [getUsersTool, notifyUserTool],
        });
        agent.addInput({ role: 'user', content: 'Notify all active users' });

        const history = await agent.run();
        assert.equal(history.length, 2);

        // Verify turn 1 executed run_tool_script
        assert.equal(history[0].executedTools[0].name, 'run_tool_script');

        // Verify tool result in context
        const messages = history[0].context.getMessages();
        const toolResultMsg = messages.find(isToolResult);
        assert.ok(toolResultMsg);

        const val = toolResultMsg.output;
        assert.equal(val.result.totalNotified, 2);
        assert.deepEqual(val.result.recipients, ['Alice', 'Charlie']);
        assert.match(val.logs, /Fetched 3 users/);

        // Turn 2 finishes
        assert.equal(history[1].isDone, true);
        assert.match(history[1].output, /Alice, Charlie/);
    });

    test('3. telemetry tags direct model calls with origin: model and brokered calls with origin: sandbox', async () => {
        const events = new EventEmitter();
        const traceEvents = [];

        events.on('tool:start', (ev) => traceEvents.push({ type: 'start', ...ev }));
        events.on('tool:complete', (ev) => traceEvents.push({ type: 'complete', ...ev }));

        const scriptCode = `
            const users = await get_users({ limit: 1 });
            return users[0].name;
        `;

        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'run_tool_script',
            args: { code: scriptCode },
            call_id: 'call_script_tel',
        }));
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Done'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'telemetry-agent',
            eventEmitter: events,
            codeMode: true,
            tools: [getUsersTool],
        });
        agent.addInput({ role: 'user', content: 'Test telemetry' });

        await agent.run();

        // Check tool:start events
        const scriptStart = traceEvents.find(e => e.type === 'start' && e.attributes.tool_name === 'run_tool_script');
        assert.ok(scriptStart);
        assert.equal(scriptStart.attributes.origin, 'model');

        const brokeredStart = traceEvents.find(e => e.type === 'start' && e.attributes.tool_name === 'get_users');
        assert.ok(brokeredStart);
        assert.equal(brokeredStart.attributes.origin, 'sandbox');

        // Check parentSpanId correlation: brokered tool span is child of run_tool_script span
        assert.equal(brokeredStart.parentSpanId, scriptStart.spanId);
    });

    test('4. approveToolCall can approve run_tool_script but reject unauthorized inner sandbox call', async () => {
        const scriptCode = `
            try {
                await delete_database({ confirm: true });
                return "deleted";
            } catch (err) {
                console.log("Deletion failed:", err.message);
                return "rejected_as_expected";
            }
        `;

        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'run_tool_script',
            args: { code: scriptCode },
            call_id: 'call_dangerous_script',
        }));
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Handled'));

        const approvalLog = [];
        const approveToolCall = async ({ name, origin }) => {
            approvalLog.push({ name, origin });
            if (origin === 'model' && name === 'run_tool_script') {
                return true; // model approved to run script
            }
            if (origin === 'sandbox' && name === 'delete_database') {
                return false; // reject dangerous inner call!
            }
            return true;
        };

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'security-agent',
            codeMode: true,
            approveToolCall,
            tools: [dangerousTool],
        });
        agent.addInput({ role: 'user', content: 'Run deletion' });

        const history = await agent.run();

        // Verify approveToolCall was invoked for both model and sandbox calls
        assert.equal(approvalLog.length, 2);
        assert.deepEqual(approvalLog[0], { name: 'run_tool_script', origin: 'model' });
        assert.deepEqual(approvalLog[1], { name: 'delete_database', origin: 'sandbox' });

        // Verify the inner script caught the rejection
        const messages = history[0].context.getMessages();
        const toolResultMsg = messages.find(isToolResult);
        assert.ok(toolResultMsg);
        assert.equal(toolResultMsg.output.result, 'rejected_as_expected');
        assert.match(toolResultMsg.output.logs, /rejected by approveToolCall hook/i);
    });

    test('5. supports injecting a custom sandbox conforming to the Sandbox contract', async () => {
        let customRan = false;
        const customSandbox = {
            run: async () => {
                customRan = true;
                return { result: 'custom_output', logs: 'custom_log', error: null };
            },
        };
        assert.doesNotThrow(() => assertSandbox(customSandbox));

        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'run_tool_script',
            args: { code: 'return 1;' },
            call_id: 'call_custom_box',
        }));
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Done'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'custom-sandbox-agent',
            codeMode: true,
            sandbox: customSandbox,
            tools: [getUsersTool],
        });
        agent.addInput({ role: 'user', content: 'Run custom' });

        const history = await agent.run();
        assert.equal(customRan, true);

        const messages = history[0].context.getMessages();
        const toolResultMsg = messages.find(isToolResult);
        assert.ok(toolResultMsg);
        assert.equal(toolResultMsg.output.result, 'custom_output');
        assert.equal(toolResultMsg.output.logs, 'custom_log');
    });
});
