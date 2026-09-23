import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoader } from '../src/loaders/tool-loader.js';
import { defineTool } from '../src/tools/define-tool.js';

describe('ToolLoader Registry & Lifecycle', () => {

    test('getToolDeclarations returns metadata without func', () => {
        const loader = new ToolLoader();
        loader.addTool({
            name: 'calc',
            description: 'Calculator',
            parameters: { type: 'object' },
            func: async () => 42,
        });

        const declarations = loader.getToolDeclarations();
        assert.equal(declarations.length, 1);
        assert.equal(declarations[0].name, 'calc');
        assert.equal(declarations[0].description, 'Calculator');
        assert.deepEqual(declarations[0].parameters, { type: 'object' });
        assert.equal(declarations[0].type, 'function');
        assert.equal(declarations[0].func, undefined, 'Declaration must NOT contain func');
    });

    test('getTools and findTool return fused records with callable func', async () => {
        const loader = new ToolLoader();
        loader.addTool(
            defineTool(
                { name: 'greet', description: 'Greeting' },
                async ({ name }) => `Hello, ${name}!`
            )
        );

        const tools = loader.getTools();
        assert.equal(tools.length, 1);
        assert.equal(typeof tools[0].func, 'function');
        assert.equal(await tools[0].func({ name: 'World' }), 'Hello, World!');

        const found = loader.findTool('greet');
        assert.ok(found);
        assert.equal(found.name, 'greet');
        assert.equal(typeof found.func, 'function');
        assert.equal(await found.func({ name: 'Alice' }), 'Hello, Alice!');

        assert.equal(loader.findTool('nonexistent'), null);
    });

    test('native provider tools without func appear in declarations and getTools', () => {
        const loader = new ToolLoader();
        loader.addTool({ type: 'web_search' });
        loader.addTool({
            name: 'custom_func',
            func: async () => 'ok',
        });

        const declarations = loader.getToolDeclarations();
        assert.equal(declarations.length, 2);
        assert.equal(declarations[0].type, 'web_search');
        assert.equal(declarations[0].func, undefined);
        assert.equal(declarations[1].name, 'custom_func');

        const tools = loader.getTools();
        assert.equal(tools.length, 2);
        assert.equal(tools[0].type, 'web_search');
        assert.equal(tools[0].func, undefined);
        assert.equal(typeof tools[1].func, 'function');
    });

    test('addTools is atomic: if any item fails, no tools in the batch are registered', () => {
        const loader = new ToolLoader();
        loader.addTool({ name: 'existing', func: async () => {} });

        const batch = [
            { name: 'tool_1', func: async () => {} },
            { name: 'tool_2', func: async () => {} },
            { name: 'existing', func: async () => {} }, // Duplicate with existing
            { name: 'tool_3', func: async () => {} },
        ];

        assert.throws(() => loader.addTools(batch), {
            message: /Tool with name 'existing' already exists/,
        });

        // None of the batch items should be registered
        assert.equal(loader.findTool('tool_1'), null);
        assert.equal(loader.findTool('tool_2'), null);
        assert.equal(loader.findTool('tool_3'), null);
        assert.equal(loader.getToolDeclarations().length, 1);
    });

    test('addTools rejects internal duplicates within the incoming batch', () => {
        const loader = new ToolLoader();
        const batch = [
            { name: 'batch_tool', func: async () => {} },
            { name: 'batch_tool', func: async () => {} },
        ];

        assert.throws(() => loader.addTools(batch), {
            message: /Tool with name 'batch_tool' already exists/,
        });
        assert.equal(loader.getToolDeclarations().length, 0);
    });

    test('local tools list before MCP tools in declaration and getTools order', async () => {
        const fakeMcpManager = {
            addServer: async () => ({
                serverName: 'test-mcp',
                tools: [
                    { name: 'shared_name', func: async () => 'mcp-impl' },
                ],
            }),
            removeServer: async () => true,
            cleanup: async () => {},
            getServerInfo: () => ({ enabled: true }),
        };

        const loader = new ToolLoader(true, {
            mcpManagerFactory: () => fakeMcpManager,
        });

        // Add local tool first
        loader.addTool({
            name: 'local_only',
            func: async () => 'local-impl',
        });

        await loader.addMCPServer('test-mcp', {});

        // Local tools are listed first
        const declarations = loader.getToolDeclarations();
        assert.equal(declarations.length, 2);
        assert.equal(declarations[0].name, 'local_only');
        assert.equal(declarations[1].name, 'shared_name');

        const foundLocal = loader.findTool('local_only');
        assert.equal(await foundLocal.func(), 'local-impl');

        const foundMcp = loader.findTool('shared_name');
        assert.equal(await foundMcp.func(), 'mcp-impl');
    });

    test('MCP registration rolls back if returned tools conflict with local tools', async () => {
        let removeServerCalled = false;
        const fakeMcpManager = {
            addServer: async () => ({
                serverName: 'server-1',
                tools: [
                    { name: 'conflict_tool', func: async () => 'mcp' },
                ],
            }),
            removeServer: async (serverName) => {
                if (serverName === 'server-1') {
                    removeServerCalled = true;
                    return true;
                }
                return false;
            },
            cleanup: async () => {},
            getServerInfo: () => ({ enabled: true }),
        };

        const loader = new ToolLoader(true, {
            mcpManagerFactory: () => fakeMcpManager,
        });

        loader.addTool({
            name: 'conflict_tool',
            func: async () => 'local',
        });

        await assert.rejects(
            async () => loader.addMCPServer('server-1', {}),
            {
                message: /MCP tool with name 'conflict_tool' already exists/,
            }
        );

        assert.ok(removeServerCalled, 'removeServer must be called to rollback server connection');
        assert.equal(loader.getToolDeclarations().length, 1);
        assert.equal(await loader.findTool('conflict_tool').func(), 'local');
    });

    test('MCP registration throws AggregateError if rollback fails after validation error', async () => {
        const fakeMcpManager = {
            addServer: async () => ({
                serverName: 'failing-rollback-server',
                tools: [
                    { name: 'invalid_tool' }, // missing func
                ],
            }),
            removeServer: async () => {
                throw new Error('Rollback network failure');
            },
            cleanup: async () => {},
            getServerInfo: () => ({ enabled: true }),
        };

        const loader = new ToolLoader(true, {
            mcpManagerFactory: () => fakeMcpManager,
        });

        await assert.rejects(
            async () => loader.addMCPServer('failing-rollback-server', {}),
            (err) => {
                assert.ok(err instanceof AggregateError, 'Must be AggregateError');
                assert.equal(err.errors.length, 2);
                assert.ok(err.errors[0].message.includes('Tool missing func'));
                assert.ok(err.errors[1].message.includes('Rollback network failure'));
                return true;
            }
        );
    });

    test('removeMCPServer removes server tools and cleanup clears MCP tools but keeps local tools', async () => {
        const fakeMcpManager = {
            addServer: async (serverName) => ({
                serverName,
                tools: [
                    { name: `${serverName}_tool`, func: async () => serverName },
                ],
            }),
            removeServer: async () => true,
            cleanup: async () => {},
            getServerInfo: () => ({ enabled: true }),
        };

        const loader = new ToolLoader(true, {
            mcpManagerFactory: () => fakeMcpManager,
        });

        loader.addTool({ name: 'my_local_tool', func: async () => 'local' });
        await loader.addMCPServer('serverA', {});
        await loader.addMCPServer('serverB', {});

        assert.equal(loader.getToolDeclarations().length, 3);
        assert.ok(loader.findTool('serverA_tool'));
        assert.ok(loader.findTool('serverB_tool'));

        // Remove serverA
        await loader.removeMCPServer('serverA');
        assert.equal(loader.findTool('serverA_tool'), null);
        assert.ok(loader.findTool('serverB_tool'));
        assert.equal(loader.getToolDeclarations().length, 2);

        // Cleanup
        await loader.cleanup();
        assert.equal(loader.findTool('serverB_tool'), null);
        assert.ok(loader.findTool('my_local_tool'), 'Local tools must survive cleanup');
        assert.equal(loader.getToolDeclarations().length, 1);
    });

    test('MCP registration rolls back if returned tools conflict with another MCP server', async () => {
        const removedServers = [];
        const servers = {
            'server-1': [
                { name: 'server1_tool', func: async () => 's1' },
                { name: 'duplicate_tool', func: async () => 's1-dup' },
            ],
            'server-2': [
                { name: 'server2_tool', func: async () => 's2' },
                { name: 'duplicate_tool', func: async () => 's2-dup' }, // Conflicts with server-1
            ],
        };

        const fakeMcpManager = {
            addServer: async (serverName) => ({
                serverName,
                tools: servers[serverName] || [],
            }),
            removeServer: async (serverName) => {
                removedServers.push(serverName);
                return true;
            },
            cleanup: async () => {},
            getServerInfo: () => ({ enabled: true }),
        };

        const loader = new ToolLoader(true, {
            mcpManagerFactory: () => fakeMcpManager,
        });

        // First server registers cleanly
        await loader.addMCPServer('server-1', {});
        assert.equal(loader.getToolDeclarations().length, 2);

        // Second server conflicts on 'duplicate_tool'
        await assert.rejects(
            async () => loader.addMCPServer('server-2', {}),
            {
                message: /MCP tool with name 'duplicate_tool' already exists/,
            }
        );

        // Verify server-2 was rolled back
        assert.deepEqual(removedServers, ['server-2']);

        // Verify server-1 tools remained registered and unharmed
        assert.equal(loader.getToolDeclarations().length, 2);
        assert.ok(loader.findTool('server1_tool'));
        assert.equal(await loader.findTool('duplicate_tool').func(), 's1-dup');
        assert.equal(loader.findTool('server2_tool'), null);
    });

    test('getSystemPromptSnippet uses declarations and omits empty tools', () => {
        const loader = new ToolLoader();
        assert.equal(loader.getSystemPromptSnippet(), '');

        loader.addTool({
            name: 'weather',
            description: 'Get weather',
            func: async () => {},
        });
        const snippet = loader.getSystemPromptSnippet();
        assert.ok(snippet.includes('weather: Get weather'));
    });
});
