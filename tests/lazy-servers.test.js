import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { ToolLoader } from '../src/loaders/tool-loader.js';
import { exposeProgressive } from '../src/tools/exposure.js';

/**
 * Creates a mock ToolSource for testing lazy server lifecycle.
 */
function createMockSource({
    serverName,
    tools = [],
    description = '',
    onConnect = null,
    onClose = null,
} = {}) {
    let connected = false;
    let closed = false;

    return {
        serverName,
        description,
        async connect() {
            connected = true;
            if (onConnect) await onConnect();
        },
        async list() {
            return tools.map(t => ({
                name: t.name,
                description: t.description || '',
                parameters: t.parameters || { type: 'object' },
            }));
        },
        async invoke(name, args, context) {
            const tool = tools.find(t => t.name === name);
            if (!tool) throw new Error(`Tool ${name} not found`);
            return tool.func ? await tool.func(args, context) : null;
        },
        getDeclarations() {
            return tools.map(t => ({
                name: t.name,
                description: t.description || '',
                parameters: t.parameters || { type: 'object' },
                type: 'function',
            }));
        },
        getTools() {
            return tools;
        },
        async close() {
            closed = true;
            connected = false;
            if (onClose) await onClose();
        },
        describe() {
            return {
                id: serverName,
                kind: 'mcp',
                title: serverName,
                description: description || `Mock tools from ${serverName}`,
                connected,
            };
        },
        isConnected: () => connected,
        isClosed: () => closed,
    };
}

describe('Lazy MCP Servers Lifecycle (tests/lazy-servers.test.js)', () => {
    test('1. registerMCPServer validates input and records blueprint without connecting', () => {
        const loader = new ToolLoader();

        assert.throws(() => loader.registerMCPServer('', {}), {
            name: 'TypeError',
            message: /non-empty 'serverName' string/,
        });

        assert.throws(() => loader.registerMCPServer('test', null), {
            name: 'TypeError',
            message: /valid 'serverConfig' object/,
        });

        let connectCalled = false;
        const res = loader.registerMCPServer('tax_server', { type: 'inMemory' }, {
            description: 'Calculates sales tax and VAT',
            sourceFactory: (opts) => createMockSource({
                ...opts,
                onConnect: () => { connectCalled = true; },
            }),
        });

        assert.equal(res.serverName, 'tax_server');
        assert.equal(res.status, 'dormant');
        assert.equal(connectCalled, false, 'registerMCPServer must NOT connect to server');

        // Cannot re-register the same server
        assert.throws(() => loader.registerMCPServer('tax_server', {}), {
            message: /already registered/,
        });

        // Catalog remains empty
        assert.equal(loader.getToolDeclarations().length, 0);
        assert.equal(loader.findTool('tax_server_calculate'), null);

        // Status reported in getRegisteredMCPServers
        const list = loader.getRegisteredMCPServers();
        assert.equal(list.length, 1);
        assert.deepEqual(list[0], {
            name: 'tax_server',
            description: 'Calculates sales tax and VAT',
            status: 'dormant',
            toolCount: 0,
        });
    });

    test('2. enableMCPServer connects mid-run, lists tools, and emits mcp:server_enabled', async () => {
        const events = new EventEmitter();
        const enabledEvents = [];
        events.on('mcp:server_enabled', (e) => enabledEvents.push(e));

        const loader = new ToolLoader(false, { eventEmitter: events });

        let mockSource;
        loader.registerMCPServer('billing_server', { type: 'inMemory' }, {
            description: 'Invoicing and billing service',
            sourceFactory: (opts) => {
                mockSource = createMockSource({
                    ...opts,
                    tools: [
                        {
                            name: 'billing_server_generate_invoice',
                            description: 'Generate customer invoice',
                            func: async ({ id }) => ({ invoiceId: id, status: 'issued' }),
                        },
                    ],
                });
                return mockSource;
            },
        });

        // Enable server
        const enableResult = await loader.enableMCPServer('billing_server');
        assert.equal(enableResult.serverName, 'billing_server');
        assert.equal(enableResult.status, 'active');
        assert.equal(enableResult.toolCount, 1);
        assert.ok(mockSource.isConnected());

        // Event emitted
        assert.equal(enabledEvents.length, 1);
        assert.equal(enabledEvents[0].serverName, 'billing_server');
        assert.equal(enabledEvents[0].toolCount, 1);

        // Tool is now available in declarations and findTool
        const declarations = loader.getToolDeclarations();
        assert.equal(declarations.length, 1);
        assert.equal(declarations[0].name, 'billing_server_generate_invoice');

        const tool = loader.findTool('billing_server_generate_invoice');
        assert.ok(tool);
        const invocation = await tool.func({ id: 'inv-42' });
        assert.deepEqual(invocation, { invoiceId: 'inv-42', status: 'issued' });

        // Idempotency: enabling again is a no-op
        const reEnableResult = await loader.enableMCPServer('billing_server');
        assert.equal(reEnableResult.status, 'active');
        assert.equal(reEnableResult.toolCount, 1);
    });

    test('3. enableMCPServer collision rollback disconnects and leaves catalog clean', async () => {
        const loader = new ToolLoader();
        loader.addTool({
            name: 'existing_tool',
            description: 'Existing local tool',
            func: async () => 'local',
        });

        let mockSource;
        loader.registerMCPServer('colliding_server', {}, {
            sourceFactory: (opts) => {
                mockSource = createMockSource({
                    ...opts,
                    tools: [
                        {
                            name: 'existing_tool', // Collision!
                            func: async () => 'collision',
                        },
                    ],
                });
                return mockSource;
            },
        });

        await assert.rejects(
            async () => loader.enableMCPServer('colliding_server'),
            { message: /MCP tool with name 'existing_tool' already exists/ }
        );

        assert.ok(mockSource.isClosed(), 'Source must be closed on rollback');
        assert.equal(loader.getToolDeclarations().length, 1);
        assert.equal(loader.getToolDeclarations()[0].name, 'existing_tool');
        assert.equal(await loader.findTool('existing_tool').func(), 'local');
    });

    test('4. disableMCPServer removes tools and keeps warm connection by default', async () => {
        const events = new EventEmitter();
        const disabledEvents = [];
        events.on('mcp:server_disabled', (e) => disabledEvents.push(e));

        const loader = new ToolLoader(false, { eventEmitter: events });
        let mockSource;
        loader.registerMCPServer('cache_server', {}, {
            description: 'Cache operations',
            sourceFactory: (opts) => {
                mockSource = createMockSource({
                    ...opts,
                    tools: [
                        { name: 'cache_get', func: async () => 'val' },
                    ],
                });
                return mockSource;
            },
        });

        await loader.enableMCPServer('cache_server');
        assert.equal(loader.getToolDeclarations().length, 1);

        // Disable with disconnect: false (default)
        const disabled = await loader.disableMCPServer('cache_server');
        assert.equal(disabled, true);
        assert.equal(disabledEvents.length, 1);
        assert.equal(disabledEvents[0].serverName, 'cache_server');

        // Tools removed from active catalog
        assert.equal(loader.getToolDeclarations().length, 0);
        assert.equal(loader.findTool('cache_get'), null);

        // Connection was NOT closed (warm connection preserved)
        assert.equal(mockSource.isClosed(), false);

        // Status is disabled
        const reg = loader.getRegisteredMCPServers();
        assert.equal(reg[0].status, 'disabled');

        // Re-enabling re-indexes without needing to re-create
        await loader.enableMCPServer('cache_server');
        assert.equal(loader.getToolDeclarations().length, 1);

        // Now disable with disconnect: true
        await loader.disableMCPServer('cache_server', { disconnect: true });
        assert.ok(mockSource.isClosed(), 'disconnect: true must close the source');
    });

    test('5. cleanup closes all active lazy server sources', async () => {
        const loader = new ToolLoader();
        let source1;
        let source2;

        loader.registerMCPServer('srv1', {}, {
            sourceFactory: (opts) => {
                source1 = createMockSource(opts);
                return source1;
            },
        });
        loader.registerMCPServer('srv2', {}, {
            sourceFactory: (opts) => {
                source2 = createMockSource(opts);
                return source2;
            },
        });

        await loader.enableMCPServer('srv1');
        // srv2 remains dormant

        await loader.cleanup();
        assert.ok(source1.isClosed(), 'Active lazy server must be closed on cleanup');
        assert.equal(source2, undefined, 'Dormant server was never instantiated');
    });

    test('6. Exposure policies expose search_servers, enable_server, and disable_server meta-tools', async () => {
        const loader = new ToolLoader();
        loader.registerMCPServer('metrics_server', {}, {
            description: 'Timeseries metrics and telemetry dashboards',
            sourceFactory: (opts) => createMockSource({
                ...opts,
                tools: [
                    { name: 'metrics_server_query_cpu', description: 'Query CPU usage' },
                ],
            }),
        });

        // Test exposeProgressive with registered lazy servers
        const progressive = await exposeProgressive([], {}, { toolLoader: loader });
        const metaToolNames = progressive.metaTools.map(t => t.name);
        assert.ok(metaToolNames.includes('search_servers'));
        assert.ok(metaToolNames.includes('enable_server'));
        assert.ok(metaToolNames.includes('disable_server'));

        // 1. search_servers
        const searchRes = await progressive.resolve('search_servers', { query: 'telemetry and cpu metrics' }, { toolLoader: loader });
        assert.equal(searchRes.handled, true);
        assert.equal(searchRes.result.servers.length, 1);
        assert.equal(searchRes.result.servers[0].name, 'metrics_server');

        // 2. enable_server
        const enableRes = await progressive.resolve('enable_server', { name: 'metrics_server' }, { toolLoader: loader });
        assert.equal(enableRes.handled, true);
        assert.equal(enableRes.result.serverName, 'metrics_server');
        assert.equal(enableRes.result.status, 'enabled');
        assert.equal(enableRes.result.toolsAdded, 1);
        assert.deepEqual(enableRes.nextState.enabledServers, ['metrics_server']);

        // 3. disable_server
        const disableRes = await progressive.resolve('disable_server', { name: 'metrics_server' }, { toolLoader: loader });
        assert.equal(disableRes.handled, true);
        assert.equal(disableRes.result.status, 'disabled');
        assert.deepEqual(disableRes.nextState.enabledServers, []);
    });
});
