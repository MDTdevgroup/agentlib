import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import { registerProvider } from '../src/providers/registry.js';
import { defineTool } from '../src/tools/define-tool.js';
import { createA2ASource } from '../src/tools/sources/index.js';
import {
    estimateDeclarationTokens,
    exposeAll,
    exposeProgressive,
    exposeAuto,
} from '../src/tools/exposure.js';
import * as FakeProvider from './helpers/fake-provider.js';

describe('Tool Exposure Policies & Agent Integration (tool-exposure.test.js)', () => {
    let fakeProvider;

    beforeEach(() => {
        fakeProvider = FakeProvider.createFakeProvider();
        registerProvider('fake', fakeProvider, 'Fake Provider');
    });

    const weatherTool = defineTool(
        {
            name: 'get_weather',
            description: 'Fetch current weather for a city',
            parameters: {
                type: 'object',
                properties: {
                    city: { type: 'string' },
                },
                required: ['city'],
            },
        },
        async ({ city }) => ({ city, temperatureF: 72, condition: 'Sunny' })
    );

    const currencyTool = defineTool(
        {
            name: 'convert_currency',
            description: 'Convert an amount between two currencies',
            parameters: {
                type: 'object',
                properties: {
                    amount: { type: 'number' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                },
                required: ['amount', 'from', 'to'],
            },
        },
        async ({ amount, from, to }) => ({ amount, from, to, converted: amount * 1.1 })
    );

    test('1. Facade mode returns an identical tools array across all turns of a multi-turn run', async () => {
        // Turn 1: search_tools
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'search_tools',
            args: { query: 'weather city' },
            call_id: 'call_facade_search',
        }));

        // Turn 2: get_tool_details (adds get_weather to exposure.discovered)
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'get_tool_details',
            args: { names: ['get_weather'] },
            call_id: 'call_facade_details',
        }));

        // Turn 3: call_tool invokes get_weather and convert_currency (adds convert_currency to discovered)
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'call_tool',
            args: {
                name: 'get_weather',
                arguments: { city: 'London' },
            },
            call_id: 'call_facade_invoke',
        }));

        // Turn 4: Final text response
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('It is 72F and Sunny in London.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'facade-cache-agent',
            toolExposure: 'progressive',
            toolExposureOptions: { mode: 'facade' },
            tools: [weatherTool, currencyTool],
        });
        agent.addInput({ role: 'user', content: 'What is the weather in London?' });

        const history = await agent.run();
        assert.equal(history.length, 4);
        assert.equal(history[3].isDone, true);
        assert.deepEqual(history[2].exposure.discovered, ['get_weather']);

        const calls = fakeProvider.getCalls();
        assert.equal(calls.length, 4);

        const turn1Tools = calls[0].options.tools;
        const turn2Tools = calls[1].options.tools;
        const turn3Tools = calls[2].options.tools;
        const turn4Tools = calls[3].options.tools;

        // Core guarantee of facade mode: the wire tools array is 100% identical across every turn
        assert.deepEqual(turn2Tools, turn1Tools, 'Turn 2 tools array must be identical to Turn 1');
        assert.deepEqual(turn3Tools, turn1Tools, 'Turn 3 tools array must be identical to Turn 1 even after get_tool_details');
        assert.deepEqual(turn4Tools, turn1Tools, 'Turn 4 tools array must be identical to Turn 1 even after call_tool');

        const wireToolNames = turn1Tools.map(t => t.name);
        assert.deepEqual(wireToolNames, ['search_tools', 'get_tool_details', 'call_tool']);
    });

    test('2. Expand mode mutates wire tools array after get_tool_details to expose discovered tool directly', async () => {
        // Turn 1: get_tool_details
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'get_tool_details',
            args: { names: ['convert_currency'] },
            call_id: 'call_expand_details',
        }));

        // Turn 2: Direct call to convert_currency
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'convert_currency',
            args: { amount: 100, from: 'EUR', to: 'USD' },
            call_id: 'call_expand_direct',
        }));

        // Turn 3: Final text
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('100 EUR is 110 USD.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'expand-agent',
            toolExposure: 'progressive',
            toolExposureOptions: { mode: 'expand' },
            tools: [weatherTool, currencyTool],
        });
        agent.addInput({ role: 'user', content: 'Convert 100 EUR to USD' });

        const history = await agent.run();
        assert.equal(history.length, 3);

        const calls = fakeProvider.getCalls();
        const turn1Names = calls[0].options.tools.map(t => t.name);
        const turn2Names = calls[1].options.tools.map(t => t.name);

        assert.deepEqual(turn1Names, ['search_tools', 'get_tool_details']);
        assert.deepEqual(turn2Names, ['search_tools', 'get_tool_details', 'convert_currency']);
    });

    test('3. Auto exposure policy threshold math: stays in exposeAll below budget and switches above budget', async () => {
        const catalog = [weatherTool, currencyTool].map(({ name, description, parameters }) => ({
            type: 'function',
            name,
            description,
            parameters,
        }));

        const totalTokens = estimateDeclarationTokens(catalog);
        assert.ok(totalTokens > 20, 'Catalog token estimate should be positive');

        // 1. Budget larger than totalTokens -> exposeAll
        const highBudgetRes = await exposeAuto(
            catalog,
            {},
            { maxContextTokens: 128000 },
            { thresholdRatio: 0.05 } // 6,400 token budget
        );
        assert.equal(highBudgetRes.metaTools.length, 0);
        assert.equal(highBudgetRes.declarations.length, 2);
        assert.equal(highBudgetRes.nextState.switched, undefined);

        // 2. Budget smaller than totalTokens -> switches to exposeProgressive
        const lowBudgetRes = await exposeAuto(
            catalog,
            {},
            { maxContextTokens: 1000 },
            { thresholdRatio: 0.01 } // 10 token budget < totalTokens
        );
        assert.equal(lowBudgetRes.metaTools.length, 2);
        assert.equal(lowBudgetRes.nextState.switched, true);
    });

    test('4. Lazy A2A ToolSource integrates with search_servers, enable_server, and search_tools', async () => {
        const a2aSource = createA2ASource('http://localhost:9999', {
            id: 'analytics',
            lazy: true,
            description: 'Sales forecasting remote peer',
            clientFactory: async () => ({
                getAgentCard: async () => ({
                    name: 'AnalyticsPeer',
                    description: 'Remote analytics agent',
                    url: 'http://localhost:9999/a2a',
                    skills: [
                        { id: 'forecast_sales', name: 'Forecast Sales', description: 'Forecast quarterly revenue' },
                    ],
                }),
                sendMessage: async () => ({
                    kind: 'message',
                    parts: [{ kind: 'text', text: 'Q4 forecast: $1.2M' }],
                }),
            }),
        });

        // Turn 1: Model searches lazy servers
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'search_servers',
            args: { query: 'sales forecasting' },
            call_id: 'call_srv_search',
        }));

        // Turn 2: Model enables 'analytics' server
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'enable_server',
            args: { name: 'analytics' },
            call_id: 'call_srv_enable',
        }));

        // Turn 3: Model searches tools and finds analytics_forecast_sales
        fakeProvider.enqueueResponse(FakeProvider.fakeToolCallResponse({
            name: 'search_tools',
            args: { query: 'forecast quarterly revenue' },
            call_id: 'call_tool_search',
        }));

        // Turn 4: Final response
        fakeProvider.enqueueResponse(FakeProvider.fakeTextResponse('Found analytics_forecast_sales tool.'));

        const llm = new LLMService({ provider: 'fake' });
        const agent = new Agent(llm, {
            name: 'lazy-a2a-agent',
            toolExposure: 'progressive',
            sources: [a2aSource],
            tools: [weatherTool],
        });
        agent.addInput({ role: 'user', content: 'Find the sales forecasting tool' });

        const history = await agent.run();
        assert.equal(history.length, 4);
        assert.deepEqual(history[1].exposure.enabledServers, ['analytics']);

        // Verify catalog now contains analytics_forecast_sales
        const fullCatalog = agent.getFullCatalog();
        assert.ok(fullCatalog.some(d => d.name === 'analytics_forecast_sales'));
    });

    test('5. Direct exposeAll and exposeProgressive contracts preserve native provider tools', async () => {
        const catalogWithNative = [
            {
                type: 'function',
                name: 'get_weather',
                description: 'Fetch weather',
                parameters: { type: 'object', properties: {} },
            },
            {
                type: 'web_search',
            },
        ];

        const allRes = await exposeAll(catalogWithNative, {});
        assert.equal(allRes.declarations.length, 2);

        const progRes = await exposeProgressive(catalogWithNative, {}, {}, { mode: 'facade' });
        assert.ok(progRes.declarations.some(d => d.type === 'web_search'));
        assert.ok(progRes.declarations.some(d => d.name === 'call_tool'));
        assert.ok(!progRes.declarations.some(d => d.name === 'get_weather'));
    });
});
