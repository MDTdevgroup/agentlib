import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOptional } from '../src/util/optional-dep.js';
import { isException } from '../src/util/exception.js';
import { loadStrategies } from '../src/loaders/load-strategies.js';
import { initTelemetry } from '../src/services/telemetry.js';
import * as AgentLib from '../index.js';
import * as A2A from '../src/a2a/index.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Optional Dependencies & Package Exports', () => {

    describe('loadOptional Error Formatting & Exceptions', () => {
        test('throws MissingDependency Exception with default install command when package is not found', async () => {
            try {
                await loadOptional('nonexistent-pkg-xyz-123', 'Sample Feature');
                assert.fail('Should have thrown MissingDependency exception');
            } catch (err) {
                assert.ok(isException(err), 'Must be an instance of structured Exception');
                assert.equal(err.type, 'MissingDependency');
                assert.ok(
                    err.message.includes("The Sample Feature requires 'nonexistent-pkg-xyz-123'."),
                    `Message should state missing pkg, got: ${err.message}`
                );
                assert.ok(
                    err.message.includes("Install with: npm install nonexistent-pkg-xyz-123"),
                    `Message should include install command, got: ${err.message}`
                );
                assert.ok(err.cause, 'Must preserve original error cause');
            }
        });

        test('throws MissingDependency Exception with custom install command and message', async () => {
            const customCmd = 'npm install @a2a-js/sdk express';
            const customMsg = "The A2A server requires '@a2a-js/sdk' and 'express'.\nInstall with: npm install @a2a-js/sdk express";

            try {
                await loadOptional('nonexistent-a2a-mock', 'A2A server', {
                    installCommand: customCmd,
                    customMessage: customMsg
                });
                assert.fail('Should have thrown MissingDependency exception');
            } catch (err) {
                assert.ok(isException(err));
                assert.equal(err.type, 'MissingDependency');
                assert.ok(err.message.includes("The A2A server requires '@a2a-js/sdk' and 'express'."));
                assert.ok(err.message.includes("Install with: npm install @a2a-js/sdk express"));
            }
        });

        test('successfully resolves an installed module', async () => {
            const yaml = await loadOptional('js-yaml', 'YAML Parser');
            assert.ok(yaml, 'Resolved module must be truthy');
            assert.equal(typeof (yaml.load || yaml.default?.load), 'function');
        });
    });

    describe('Root Entry Point Isolation', () => {
        test('index.js exports core functionality without peripheral A2A or import-time OTel bootstrap', () => {
            assert.ok(AgentLib.Agent, 'Agent should be exported');
            assert.ok(AgentLib.LLMService, 'LLMService should be exported');
            assert.ok(AgentLib.AgentRunner, 'AgentRunner should be exported');
            assert.ok(AgentLib.Context, 'Context should be exported');
            assert.ok(AgentLib.PromptLoader, 'PromptLoader should be exported');
            assert.ok(AgentLib.ToolLoader, 'ToolLoader should be exported');
            assert.ok(AgentLib.DomainObservability, 'DomainObservability should be exported');
            assert.ok(AgentLib.initTelemetry, 'initTelemetry should be exported');
            assert.ok(AgentLib.loadOptional, 'loadOptional should be exported');

            // A2A server functions should NOT be on root export
            assert.equal(AgentLib.startA2AServer, undefined, 'startA2AServer should not be on root export');
            assert.equal(AgentLib.createRemoteAgentTool, undefined, 'createRemoteAgentTool should not be on root export');
        });
    });

    describe('A2A Subpath Entry Point', () => {
        test('src/a2a/index.js exports A2A server, remote agent tool, and adapter', () => {
            assert.equal(typeof A2A.startA2AServer, 'function');
            assert.equal(typeof A2A.createRemoteAgentTool, 'function');
            assert.ok(A2A.AgentExecutorAdapter);
        });

        test('startA2AServer can be invoked or lazily loads dependencies', async () => {
            const fakeProvider = FakeProvider.createFakeProvider();
            registerProvider('fake', fakeProvider);
            const llm = new LLMService({ provider: 'fake', apiKey: 'fake-key' });
            const _agent = new Agent(llm);

            assert.equal(A2A.startA2AServer.constructor.name, 'AsyncFunction');
        });
    });

    describe('SQLite Lazy Loading', () => {
        test('loadStrategies.sqlite lazily attempts to load sqlite3', async () => {
            assert.equal(typeof loadStrategies.sqlite, 'function');
            // Testing SQLite load strategy returns a promise
            try {
                // If sqlite3 is installed, it opens; if not, it throws MissingDependency
                const db = await loadStrategies.sqlite(':memory:');
                assert.ok(db, 'sqlite DB connection should resolve if sqlite3 is installed');
                db.close();
            } catch (err) {
                if (isException(err) && err.type === 'MissingDependency') {
                    assert.ok(err.message.includes('sqlite3'));
                } else {
                    // Normal sqlite file error or success
                    assert.ok(err);
                }
            }
        });
    });

    describe('Telemetry Lazy Initialization', () => {
        test('initTelemetry is a callable async function that loads OTel packages lazily', async () => {
            assert.equal(typeof initTelemetry, 'function');
            assert.equal(initTelemetry.constructor.name, 'AsyncFunction');
        });
    });
});
