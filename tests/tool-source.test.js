import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    assertToolSource,
    LocalToolSource,
    MCPToolSource,
    A2AToolSource,
} from '../src/tools/sources/index.js';
import { defineTool } from '../src/tools/define-tool.js';

describe('ToolSource Contract & Implementations', () => {

    describe('assertToolSource Validator', () => {
        test('passes when all 5 methods are implemented', () => {
            const validSource = {
                describe: () => ({ id: 'test', kind: 'local', title: 'Test', description: 'Test', connected: true }),
                list: async () => [],
                invoke: async () => {},
                connect: async () => {},
                close: async () => {},
            };
            assert.doesNotThrow(() => assertToolSource(validSource));
        });

        test('throws TypeError on null or non-object', () => {
            assert.throws(() => assertToolSource(null), { name: 'TypeError' });
            assert.throws(() => assertToolSource('invalid'), { name: 'TypeError' });
        });

        test('throws TypeError when a required method is missing', () => {
            const missingInvoke = {
                describe: () => {},
                list: async () => [],
                connect: async () => {},
                close: async () => {},
            };
            assert.throws(() => assertToolSource(missingInvoke), {
                name: 'TypeError',
                message: /must implement 'invoke\(\)'/,
            });
        });
    });

    describe('LocalToolSource', () => {
        test('conforms to ToolSource contract', () => {
            const source = new LocalToolSource();
            assert.doesNotThrow(() => assertToolSource(source));
        });

        test('registers and lists tool declarations without executable closures', async () => {
            const source = new LocalToolSource();
            source.addTool(defineTool(
                { name: 'add', description: 'Add two numbers' },
                async ({ a, b }) => a + b
            ));

            const desc = source.describe();
            assert.equal(desc.id, 'local');
            assert.equal(desc.kind, 'local');
            assert.equal(desc.connected, true);

            const declarations = await source.list();
            assert.equal(declarations.length, 1);
            assert.equal(declarations[0].name, 'add');
            assert.equal(declarations[0].func, undefined);

            const result = await source.invoke('add', { a: 10, b: 32 });
            assert.equal(result, 42);
        });

        test('addTools is atomic and prevents duplicates', () => {
            const source = new LocalToolSource();
            source.addTool({ name: 'existing', func: async () => 1 });

            assert.throws(() => {
                source.addTools([
                    { name: 'valid_1', func: async () => 2 },
                    { name: 'existing', func: async () => 3 },
                ]);
            }, { message: /already exists/ });

            assert.equal(source.getDeclarations().length, 1);
            assert.equal(source.findTool('valid_1'), null);
        });

        test('close clears registered tools', async () => {
            const source = new LocalToolSource();
            source.addTool({ name: 'temp', func: async () => 'ok' });
            assert.equal(source.getDeclarations().length, 1);

            await source.close();
            assert.equal(source.getDeclarations().length, 0);
        });
    });

    describe('MCPToolSource', () => {
        test('conforms to ToolSource contract and prefixes tool names by default', async () => {
            const mockTools = [
                { name: 'read', description: 'Read a file', func: async ({ path }) => `Content of ${path}` },
                { name: 'write', description: 'Write a file', func: async () => 'done' },
            ];

            const source = new MCPToolSource({
                serverName: 'fs',
                tools: mockTools,
                prefixToolNames: true,
            });

            assert.doesNotThrow(() => assertToolSource(source));

            const desc = source.describe();
            assert.equal(desc.id, 'fs');
            assert.equal(desc.kind, 'mcp');
            assert.equal(desc.connected, true);

            const declarations = await source.list();
            assert.equal(declarations.length, 2);
            assert.equal(declarations[0].name, 'fs_read');
            assert.equal(declarations[1].name, 'fs_write');

            // Invoke with prefixed name
            const result1 = await source.invoke('fs_read', { path: '/tmp/test.txt' });
            assert.equal(result1, 'Content of /tmp/test.txt');

            // Invoke with unprefixed raw name also resolves
            const result2 = await source.invoke('read', { path: '/tmp/test2.txt' });
            assert.equal(result2, 'Content of /tmp/test2.txt');
        });

        test('supports prefixToolNames: false for unprefixed legacy names', async () => {
            const mockTools = [
                { name: 'search', description: 'Search web', func: async () => 'results' },
            ];

            const source = new MCPToolSource({
                serverName: 'search_service',
                tools: mockTools,
                prefixToolNames: false,
            });

            const declarations = await source.list();
            assert.equal(declarations[0].name, 'search');
            assert.equal(await source.invoke('search', {}), 'results');
        });

        test('throws descriptive error on unknown tool invocation', async () => {
            const source = new MCPToolSource({
                serverName: 'srv',
                tools: [],
            });

            await assert.rejects(
                async () => source.invoke('nonexistent', {}),
                { message: /Tool 'nonexistent' not found on MCP server 'srv'/ }
            );
        });
    });

    describe('A2AToolSource', () => {
        test('conforms to ToolSource contract', () => {
            const source = new A2AToolSource({
                remoteUrl: 'http://localhost:4000',
                toolName: 'analyst',
                description: 'Financial analyst agent',
            });

            assert.doesNotThrow(() => assertToolSource(source));

            const desc = source.describe();
            assert.equal(desc.id, 'analyst');
            assert.equal(desc.kind, 'a2a');
            assert.equal(desc.title, 'analyst');

            const declarations = source.getDeclarations();
            assert.equal(declarations.length, 1);
            assert.equal(declarations[0].name, 'analyst');
            assert.equal(declarations[0].description, 'Financial analyst agent');
            assert.ok(declarations[0].parameters.properties.request);

            const fused = source.toFusedTool();
            assert.equal(fused.name, 'analyst');
            assert.equal(typeof fused.func, 'function');
        });
    });
});
