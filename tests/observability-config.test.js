import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import EventEmitter from 'node:events';
import { readFileSync } from 'node:fs';

import {
    Agent,
    AgentRunner,
    LLMService,
    ToolLoader,
    DomainObservability,
    createTracer,
} from '../index.js';

import * as config from '../src/config.js';
import * as FakeProvider from './helpers/fake-provider.js';
import { registerProvider } from '../src/providers/registry.js';

describe('Observability, Config Accessors & Release Validation', () => {
    let fakeProvider;
    let originalLog, originalWarn, originalError;
    let consoleCalls = [];

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake', fakeProvider);

        originalLog = console.log;
        originalWarn = console.warn;
        originalError = console.error;
        consoleCalls = [];

        console.log = (...args) => consoleCalls.push({ type: 'log', args });
        console.warn = (...args) => consoleCalls.push({ type: 'warn', args });
        console.error = (...args) => consoleCalls.push({ type: 'error', args });
    });

    afterEach(() => {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    });

    describe('Configuration through Named Functions', () => {
        test('config exports named accessor functions with expected defaults', () => {
            assert.equal(typeof config.getDefaultProvider, 'function');
            assert.equal(config.getDefaultProvider(), 'openai');

            assert.equal(typeof config.getDefaultOpenaiModel, 'function');
            assert.equal(config.getDefaultOpenaiModel(), 'gpt-5');

            assert.equal(typeof config.getDefaultGeminiModel, 'function');
            assert.equal(config.getDefaultGeminiModel(), 'gemini-3.1-pro-preview');

            assert.equal(typeof config.getDefaultModel, 'function');
            assert.equal(config.getDefaultModel('openai'), 'gpt-5');
            assert.equal(config.getDefaultModel('gemini'), 'gemini-3.1-pro-preview');
            assert.equal(config.getDefaultModel('vllm'), 'gpt-5');

            assert.equal(config.getDefaultMaxToolCalls(), 15);
            assert.equal(config.getDefaultMaxTurns(), 5);
            assert.equal(config.getDefaultToolConcurrency(), 5);
            assert.equal(config.getDefaultMaxContextTokens(), 64000);
            assert.equal(config.getDefaultTruncateToTokens(), 48000);

            const retrySpec = config.getDefaultRetrySpec();
            assert.equal(retrySpec.maxRetries, 3);
            assert.equal(retrySpec.timeoutMS, 300000);
            assert.equal(retrySpec.baseDelayMS, 1000);
        });
    });

    describe('AgentRunner Observability & Event Routing', () => {
        test('AgentRunner emits agent_runner:* events with valid traceId and DomainObservability records them', async () => {
            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Agent runner step done'));

            const events = new EventEmitter();
            const emittedEvents = [];
            events.on('agent_runner:start', (p) => emittedEvents.push({ event: 'agent_runner:start', payload: p }));
            events.on('agent_runner:complete', (p) => emittedEvents.push({ event: 'agent_runner:complete', payload: p }));

            const tempTracesDir = path.join(process.cwd(), 'tests', 'scratch_traces_' + Date.now());
            new DomainObservability(events, { mode: 'file', baseDir: tempTracesDir });

            const llm = new LLMService({ provider: 'fake' });
            const agent = new Agent(llm, { name: 'runner_agent' });
            agent.addInput({ role: 'user', content: 'Execute turn' });

            const runner = new AgentRunner({ runner_agent: agent }, {
                name: 'test_runner',
                eventEmitter: events,
            });

            await runner.run('Start turn');
            await new Promise(r => setTimeout(r, 100));

            // Verify event emissions
            const startEvent = emittedEvents.find(e => e.event === 'agent_runner:start');
            const completeEvent = emittedEvents.find(e => e.event === 'agent_runner:complete');

            assert.ok(startEvent, 'agent_runner:start event must be emitted');
            assert.ok(completeEvent, 'agent_runner:complete event must be emitted');
            assert.ok(startEvent.payload.traceId, 'traceId must be present in telemetry payload');
            assert.ok(startEvent.payload.spanId, 'spanId must be present in telemetry payload');

            // Verify FileHandler wrote traces into disk without undefined folder name
            const files = await fs.readdir(tempTracesDir, { recursive: true });
            assert.ok(files.length > 0, 'Trace files must be written to disk');
            assert.ok(!files.some(f => f.includes('undefined')), 'Trace path must not contain "undefined"');

            // Cleanup temp traces
            await fs.rm(tempTracesDir, { recursive: true, force: true });
        });

        test('DomainObservability listens to and dispatches a2a:start, complete, and error', () => {
            const emitter = new EventEmitter();
            const obs = new DomainObservability(emitter, { mode: 'none' });
            let dispatched = [];
            obs.dispatch = async (type, payload) => { dispatched.push({ type, payload }); };

            emitter.emit('a2a:start', { name: 'server_start' });
            emitter.emit('a2a:complete', { name: 'server_start' });
            emitter.emit('a2a:error', { name: 'server_start', error: 'port in use' });

            assert.equal(dispatched.length, 3);
            assert.equal(dispatched[0].type, 'start');
            assert.equal(dispatched[1].type, 'complete');
            assert.equal(dispatched[2].type, 'error');
        });
    });

    describe('Path Traversal Defense in FileHandler', () => {
        test('FileHandler sanitizes malicious trace IDs and prevents path traversal escape', async () => {
            const tempTracesDir = path.join(process.cwd(), 'tests', 'scratch_traversal_' + Date.now());
            const events = new EventEmitter();
            new DomainObservability(events, { mode: 'file', baseDir: tempTracesDir });

            const tracer = createTracer(events, 'session_123', '../../../../etc/passwd');

            await tracer('agent:test_traversal', { foo: 'bar' }, async () => {
                return 'safe';
            });
            await new Promise(r => setTimeout(r, 100));

            // Ensure trace directory is created inside tempTracesDir and does not escape
            const resolvedBase = path.resolve(tempTracesDir);
            const subdirs = await fs.readdir(resolvedBase);
            assert.ok(subdirs.length > 0);
            assert.ok(subdirs[0].includes('passwd') || subdirs[0].includes('etc'));

            // Clean up
            await fs.rm(tempTracesDir, { recursive: true, force: true });
        });
    });

    describe('Zero Uninvited Console Side Effects', () => {
        test('Standard AgentLib workflows produce 0 console.log/warn/error calls by default', async () => {
            fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Clean response'));

            const llm = new LLMService({ provider: 'fake' });
            const toolLoader = new ToolLoader(false);
            toolLoader.addTool({
                name: 'sample_tool',
                description: 'A tool',
                func: async () => ({ status: 'ok' }),
            });

            const agent = new Agent(llm, {
                name: 'silent_agent',
                toolLoader,
                logmode: 'none',
            });

            agent.addInput({ role: 'user', content: 'Say hello' });
            await agent.run();

            // Assert that library execution produces zero console noise
            assert.equal(consoleCalls.length, 0, `Expected 0 console calls, but got: ${JSON.stringify(consoleCalls)}`);
        });
    });

    describe('Release 4.0.0 Metadata & Exports Verification', () => {
        test('package.json specifies version 4.0.0 and correct engines', () => {
            const pkgPath = path.join(process.cwd(), 'package.json');
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

            assert.equal(pkg.version, '4.0.0', 'package.json version must be 4.0.0');
            assert.ok(pkg.engines?.node, 'Node engine requirement must be specified');
            assert.ok(pkg.exports['.'], 'Root export must be defined');
            assert.ok(pkg.exports['./a2a'], 'A2A subpath export must be defined');
            assert.ok(pkg.exports['./telemetry'], 'Telemetry subpath export must be defined');
        });

        test('Subpath entrypoints export expected components', async () => {
            const root = await import('../index.js');
            assert.ok(root.Agent);
            assert.ok(root.AgentRunner);
            assert.ok(root.Context);
            assert.ok(root.LLMService);
            assert.ok(root.ToolLoader);
            assert.ok(root.PromptLoader);
            assert.ok(root.WindowCompactor);

            const a2a = await import('../src/a2a/index.js');
            assert.ok(a2a.startA2AServer);
            assert.ok(a2a.createRemoteAgentTool);
            assert.ok(a2a.AgentExecutorAdapter);

            const telemetry = await import('../src/services/telemetry.js');
            assert.ok(telemetry.initTelemetry);
        });
    });
});
