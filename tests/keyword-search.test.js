import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rankKeywords } from '../src/tools/keyword-search.js';

describe('BM25 Keyword Search (keyword-search.js)', () => {
    const catalog = [
        {
            name: 'weather_lookup',
            description: 'Look up the current weather conditions for a given city and country.',
            parameters: {
                type: 'object',
                properties: {
                    city: { type: 'string', description: 'City name' },
                    country: { type: 'string', description: 'Country code' },
                },
            },
        },
        {
            name: 'database_query',
            description: 'Execute an SQL query against the primary PostgreSQL database.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'SQL SELECT query string' },
                },
            },
        },
        {
            name: 'send_email',
            description: 'Send an email notification to recipient with subject and body.',
            parameters: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: 'Recipient email address' },
                    subject: { type: 'string', description: 'Email subject' },
                    body: { type: 'string', description: 'Email body' },
                },
            },
        },
        {
            name: 'forecast_service',
            description: 'Predict weather forecast for the next 7 days.',
            parameters: {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'City or coordinates' },
                },
            },
        },
    ];

    test('returns empty array when catalog is empty or invalid', async () => {
        assert.deepEqual(await rankKeywords('query', []), []);
        assert.deepEqual(await rankKeywords('query', null), []);
        assert.deepEqual(await rankKeywords('query', undefined), []);
    });

    test('returns top entries with score 0 when query is empty or whitespace', async () => {
        const results = await rankKeywords('', catalog, { limit: 2 });
        assert.equal(results.length, 2);
        assert.equal(results[0].score, 0);
        assert.equal(results[1].score, 0);

        const whitespaceResults = await rankKeywords('   ', catalog);
        assert.equal(whitespaceResults.length, 4);
        assert.equal(whitespaceResults[0].score, 0);
    });

    test('ranks exact name match highest with exact-match boost', async () => {
        const results = await rankKeywords('weather_lookup', catalog);
        assert.ok(results.length > 0);
        assert.equal(results[0].entry.name, 'weather_lookup');
        assert.ok(results[0].score > 10, 'Should include exact match bonus');
    });

    test('matches on description keywords', async () => {
        const results = await rankKeywords('postgresql database select', catalog);
        assert.ok(results.length > 0);
        assert.equal(results[0].entry.name, 'database_query');
    });

    test('matches on parameter names and descriptions', async () => {
        const results = await rankKeywords('recipient notification', catalog);
        assert.ok(results.length > 0);
        assert.equal(results[0].entry.name, 'send_email');
    });

    test('ranks name matches higher than description matches due to 3x field weight', async () => {
        const testTools = [
            {
                name: 'unrelated_tool',
                description: 'This tool is about forecast and climate predictions',
            },
            {
                name: 'forecast_tool',
                description: 'General utility',
            },
        ];

        const results = await rankKeywords('forecast', testTools);
        assert.equal(results.length, 2);
        assert.equal(results[0].entry.name, 'forecast_tool', 'Tool with keyword in name should rank higher');
    });

    test('respects limit parameter', async () => {
        const results = await rankKeywords('weather', catalog, { limit: 1 });
        assert.equal(results.length, 1);
    });

    test('handles entries wrapped in { declaration } format', async () => {
        const wrapped = catalog.map(c => ({ source: 'mcp-server', declaration: c }));
        const results = await rankKeywords('weather', wrapped);
        assert.ok(results.length > 0);
        assert.ok(results[0].entry.declaration.name.includes('weather'));
    });

    test('handles case-insensitivity and punctuation normalization', async () => {
        const results = await rankKeywords('WEATHER! LOOKUP???', catalog);
        assert.ok(results.length > 0);
        assert.equal(results[0].entry.name, 'weather_lookup');
    });
});
