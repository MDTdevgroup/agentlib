import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    estimateDeclarationTokens,
    exposeAll,
    exposeProgressive,
    exposeAuto,
    resolveExposurePolicy,
} from '../src/tools/exposure.js';

describe('Tool Exposure Policies (exposure.js)', () => {
    const catalog = [
        {
            name: 'weather_lookup',
            description: 'Get weather forecast',
            source: { serverName: 'weather_server' },
            parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
            },
        },
        {
            name: 'db_query',
            description: 'Run SQL query',
            source: { id: 'db_server' },
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
            },
        },
        {
            name: 'local_helper',
            description: 'Local calculation utility',
            parameters: {
                type: 'object',
                properties: { val: { type: 'number' } },
            },
        },
        {
            type: 'web_search', // Provider native tool without function parameters
        },
    ];

    describe('estimateDeclarationTokens', () => {
        test('handles null, undefined, or empty values', () => {
            assert.equal(estimateDeclarationTokens(null), 0);
            assert.equal(estimateDeclarationTokens(undefined), 0);
            assert.equal(estimateDeclarationTokens([]), 0);
        });

        test('estimates token count proportional to JSON length', () => {
            const single = { name: 'test', description: 'short description' };
            const est = estimateDeclarationTokens(single);
            assert.ok(est > 0, 'Estimate should be greater than zero');

            const batchEst = estimateDeclarationTokens([single, single]);
            assert.equal(batchEst, est * 2, 'Batch tokens should be sum of items');
        });
    });

    describe('exposeAll Policy', () => {
        test('exposes all tools from catalog upfront with empty metaTools when no lazy servers', async () => {
            const state = { custom: 123 };
            const result = await exposeAll(catalog, state);

            assert.equal(result.declarations.length, catalog.length);
            assert.deepEqual(result.metaTools, []);
            assert.deepEqual(result.nextState, state);

            const res = await result.resolve('any_tool', {});
            assert.equal(res.handled, false);
        });

        test('eager MCP servers do NOT inject lazy-server meta-tools', async () => {
            // Simulated loader with eager servers only (hasLazyServers() is false)
            const eagerLoader = {
                getRegisteredMCPServers: () => [{ name: 'playwright', config: {} }],
                hasLazyServers: () => false,
            };

            const result = await exposeAll(catalog, {}, { toolLoader: eagerLoader });
            assert.equal(result.metaTools.length, 0, 'Must NOT inject server meta-tools when only eager servers exist');
        });

        test('lazy MCP servers DO inject lazy-server meta-tools in exposeAll', async () => {
            const lazyLoader = {
                getRegisteredMCPServers: () => [{ name: 'github', description: 'GitHub API' }],
                hasLazyServers: () => true,
            };

            const result = await exposeAll(catalog, {}, { toolLoader: lazyLoader });
            assert.equal(result.metaTools.length, 3);
            assert.ok(result.metaTools.some(t => t.name === 'search_servers'));
            assert.ok(result.metaTools.some(t => t.name === 'enable_server'));
            assert.ok(result.metaTools.some(t => t.name === 'disable_server'));
        });
    });

    describe('exposeProgressive Policy', () => {
        test('exposes only meta-tools and native tools initially in expand mode', async () => {
            const result = await exposeProgressive(catalog, {}, {}, { mode: 'expand' });

            // metaTools: search_tools, get_tool_details
            assert.equal(result.metaTools.length, 2);
            assert.equal(result.metaTools[0].name, 'search_tools');
            assert.equal(result.metaTools[1].name, 'get_tool_details');

            // Wire declarations: metaTools + nativeTools (web_search)
            assert.equal(result.declarations.length, 3);
            assert.ok(result.declarations.some(d => d.type === 'web_search'));
            assert.ok(!result.declarations.some(d => d.name === 'weather_lookup'));
        });

        test('appends discovered tools on wire in expand mode', async () => {
            const state = { discovered: ['weather_lookup'] };
            const result = await exposeProgressive(catalog, state, {}, { mode: 'expand' });

            assert.equal(result.declarations.length, 4); // 2 meta + 1 native + 1 discovered
            const discoveredOnWire = result.declarations.find(d => d.name === 'weather_lookup');
            assert.ok(discoveredOnWire, 'Discovered tool should appear on wire array');
            assert.equal(discoveredOnWire.description, 'Get weather forecast');
        });

        test('facade mode includes call_tool in metaTools and keeps wire declarations strictly fixed', async () => {
            const state = { discovered: ['weather_lookup', 'db_query'] };
            const result = await exposeProgressive(catalog, state, {}, { mode: 'facade' });

            // In facade mode: 3 metaTools (search_tools, get_tool_details, call_tool)
            assert.equal(result.metaTools.length, 3);
            assert.ok(result.metaTools.some(d => d.name === 'call_tool'));

            // Wire declarations: 3 metaTools + 1 native tool = 4 (never appends individual tools)
            assert.equal(result.declarations.length, 4);
            assert.ok(!result.declarations.some(d => d.name === 'weather_lookup'));
            assert.ok(!result.declarations.some(d => d.name === 'db_query'));
        });

        test('search_tools resolves query with detail levels and groupings', async () => {
            const { resolve } = await exposeProgressive(catalog);

            // 1. name_and_description (default)
            const res1 = await resolve('search_tools', { query: 'weather' });
            assert.equal(res1.handled, true);
            assert.ok(res1.result.results.length >= 1);
            assert.equal(res1.result.results[0].name, 'weather_lookup');
            assert.ok(res1.result.results[0].description);
            assert.equal(res1.result.results[0].parameters, undefined, 'Should not expose parameters in summary');
            assert.ok(res1.result.groupedBySource['weather_server']);

            // 2. name_only
            const res2 = await resolve('search_tools', { query: 'weather', detail: 'name_only' });
            assert.equal(res2.handled, true);
            assert.deepEqual(res2.result.results[0], { name: 'weather_lookup' });

            // 3. full_schema
            const res3 = await resolve('search_tools', { query: 'weather', detail: 'full_schema' });
            assert.equal(res3.handled, true);
            assert.ok(res3.result.results[0].parameters, 'full_schema should include parameters');
        });

        test('get_tool_details retrieves full schema and records into nextState.discovered', async () => {
            const { resolve } = await exposeProgressive(catalog, { discovered: [] });

            const res = await resolve('get_tool_details', { names: ['weather_lookup', 'unknown_tool'] });
            assert.equal(res.handled, true);
            assert.equal(res.result.tools.length, 2);

            // Valid tool has parameters
            assert.equal(res.result.tools[0].name, 'weather_lookup');
            assert.ok(res.result.tools[0].parameters);

            // Unknown tool has error message
            assert.equal(res.result.tools[1].name, 'unknown_tool');
            assert.ok(res.result.tools[1].error);

            // nextState has added 'weather_lookup'
            assert.deepEqual(res.nextState.discovered, ['weather_lookup']);
        });

        test('call_tool resolves execution via context.toolLoader and records into discovered', async () => {
            let executed = false;
            let receivedArgs = null;

            const fakeToolLoader = {
                findTool: (name) => {
                    if (name === 'weather_lookup') {
                        return {
                            name: 'weather_lookup',
                            func: async (args) => {
                                executed = true;
                                receivedArgs = args;
                                return { temp: 72, condition: 'sunny' };
                            },
                        };
                    }
                    return null;
                },
            };

            const { resolve } = await exposeProgressive(catalog, {}, { toolLoader: fakeToolLoader }, { mode: 'facade' });

            const res = await resolve('call_tool', {
                name: 'weather_lookup',
                arguments: JSON.stringify({ city: 'Miami' }), // Stringified JSON args
            });

            assert.equal(res.handled, true);
            assert.equal(executed, true);
            assert.deepEqual(receivedArgs, { city: 'Miami' });
            assert.deepEqual(res.result, { temp: 72, condition: 'sunny' });
            assert.deepEqual(res.nextState.discovered, ['weather_lookup']);
        });

        test('supports injectable ranker in options', async () => {
            let customRankerCalled = false;
            const customRanker = async (query, entries) => {
                customRankerCalled = true;
                return [{ entry: entries[0], score: 999 }];
            };

            const { resolve } = await exposeProgressive(catalog, {}, {}, { rank: customRanker });
            const res = await resolve('search_tools', { query: 'test' });

            assert.equal(customRankerCalled, true);
            assert.equal(res.result.results.length, 1);
        });

        test('groups multi-word local tools under local source rather than splitting on underscore', async () => {
            const localCatalog = [
                {
                    name: 'get_weather_forecast',
                    description: 'Get weather forecast',
                    source: { kind: 'local' },
                },
                {
                    name: 'fs_read_file',
                    description: 'Read file',
                    source: { kind: 'mcp', serverName: 'fs', remoteName: 'read_file' },
                },
            ];

            const { resolve } = await exposeProgressive(localCatalog);
            const res = await resolve('search_tools', { query: 'weather' });
            assert.equal(res.handled, true);
            assert.ok(res.result.groupedBySource['local'], 'Must group under "local"');
            assert.equal(res.result.groupedBySource['get'], undefined, 'Must NOT group under "get"');
        });

        test('get_tool_details resolves by remoteName when qualified name differs', async () => {
            const prefixedCatalog = [
                {
                    name: 'fs_read_file',
                    description: 'Read a file',
                    source: { kind: 'mcp', serverName: 'fs', remoteName: 'read_file' },
                    parameters: { type: 'object' },
                },
            ];

            const { resolve } = await exposeProgressive(prefixedCatalog, { discovered: [] });
            const res = await resolve('get_tool_details', { names: ['read_file'] });
            assert.equal(res.handled, true);
            assert.equal(res.result.tools[0].name, 'fs_read_file');
            assert.deepEqual(res.nextState.discovered, ['fs_read_file']);
        });
    });

    describe('exposeAuto Policy', () => {
        test('returns exposeAll when estimated tokens are below threshold', async () => {
            // maxContextTokens = 100,000; thresholdRatio = 0.05 => threshold = 5,000 tokens
            const result = await exposeAuto(catalog, {}, { maxContextTokens: 100000 }, { thresholdRatio: 0.05 });
            assert.equal(result.declarations.length, catalog.length);
            assert.deepEqual(result.metaTools, []);
        });

        test('forwards context to exposeAll below threshold so lazy servers are discoverable', async () => {
            const lazyLoader = {
                getRegisteredMCPServers: () => [{ name: 'github', description: 'GitHub API' }],
                hasLazyServers: () => true,
            };

            const result = await exposeAuto(
                catalog,
                {},
                { maxContextTokens: 100000, toolLoader: lazyLoader },
                { thresholdRatio: 0.05 }
            );

            assert.equal(result.declarations.length, catalog.length + 3);
            assert.equal(result.metaTools.length, 3);
            assert.ok(result.metaTools.some(t => t.name === 'search_servers'));
        });

        test('switches to progressive when estimated tokens exceed threshold', async () => {
            // maxContextTokens = 100; thresholdRatio = 0.01 => threshold = 1 token
            const result = await exposeAuto(catalog, {}, { maxContextTokens: 100 }, { thresholdRatio: 0.01 });

            assert.equal(result.metaTools.length, 2);
            assert.ok(result.nextState.switched, 'Should set switched: true in nextState');
        });

        test('remains progressive once switched is true even if context increases', async () => {
            const result = await exposeAuto(catalog, { switched: true }, { maxContextTokens: 1000000 });
            assert.equal(result.metaTools.length, 2);
            assert.ok(result.nextState.switched);
        });
    });

    describe('resolveExposurePolicy Factory', () => {
        test('resolves string names correctly', async () => {
            const allPolicy = resolveExposurePolicy('all');
            const progPolicy = resolveExposurePolicy('progressive');
            const autoPolicy = resolveExposurePolicy('auto');

            assert.equal(typeof allPolicy, 'function');
            assert.equal(typeof progPolicy, 'function');
            assert.equal(typeof autoPolicy, 'function');

            const allRes = await allPolicy(catalog, {});
            assert.equal(allRes.metaTools.length, 0);

            const progRes = await progPolicy(catalog, {});
            assert.equal(progRes.metaTools.length, 2);
        });

        test('returns custom policy function directly', () => {
            const custom = async () => ({ declarations: [], metaTools: [], resolve: () => ({ handled: false }), nextState: {} });
            const resolved = resolveExposurePolicy(custom);
            assert.equal(resolved, custom);
        });
    });
});
