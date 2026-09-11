import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoader } from '../src/loaders/tool-loader.js';
import {
    generatorTools,
    executorTools,
    mainAgentTools,
} from '../examples/sqlAgent/tools/index.js';
import { isException } from '../src/util/exception.js';

describe('SQL Agent Tool Catalog (Modular Layout Smoke Test)', () => {

    test('constructs and executes generator tools with fake database', async () => {
        const recordedQueries = [];
        const fakeDb = {
            all: async (sql) => {
                recordedQueries.push(sql);
                if (sql.includes('sqlite_master')) {
                    return [{ name: 'artists' }, { name: 'albums' }];
                }
                return [{ cid: 0, name: 'ArtistId', type: 'INTEGER' }];
            },
        };

        const tools = generatorTools(fakeDb);
        assert.equal(tools.length, 2);

        const listTablesTool = tools.find(t => t.name === 'list_tables');
        const getSchemaTool = tools.find(t => t.name === 'get_schema');
        assert.ok(listTablesTool);
        assert.ok(getSchemaTool);

        const tables = await listTablesTool.func();
        assert.deepEqual(tables, ['artists', 'albums']);

        const schema = await getSchemaTool.func({ table: 'artists' });
        assert.deepEqual(schema, [{ cid: 0, name: 'ArtistId', type: 'INTEGER' }]);
        assert.ok(recordedQueries.some(q => q.includes("PRAGMA table_info('artists')")));
    });

    test('constructs executor tools and validates run_query arguments', async () => {
        const recordedQueries = [];
        const fakeDb = {
            all: async (sql) => {
                recordedQueries.push(sql);
                return [{ result: 42 }];
            },
        };

        const tools = executorTools(fakeDb);
        assert.equal(tools.length, 3);

        const runQueryTool = tools.find(t => t.name === 'run_query');
        assert.ok(runQueryTool);

        const res = await runQueryTool.func({ query: 'SELECT 42;' });
        assert.deepEqual(res, [{ result: 42 }]);

        // withValidation should reject invalid query argument
        await assert.rejects(
            async () => runQueryTool.func({ query: '' }),
            (err) => {
                assert.ok(isException(err));
                assert.equal(err.type, 'ToolArgumentInvalid');
                assert.ok(err.message.includes('requires a non-empty string "query" parameter'));
                return true;
            }
        );
    });

    test('constructs main router agent tools and delegates to templated queries', async () => {
        const recordedQueries = [];
        const fakeDb = {
            all: async (sql) => {
                recordedQueries.push(sql);
                return [{ TotalSales: 500 }];
            },
        };

        const tools = mainAgentTools(fakeDb);
        assert.equal(tools.length, 3);

        const salesTool = tools.find(t => t.name === 'find_sales_for_artist');
        const tracksTool = tools.find(t => t.name === 'find_top_tracks_in_genre');
        const customTool = tools.find(t => t.name === 'generate_custom_sql_query');

        assert.ok(salesTool);
        assert.ok(tracksTool);
        assert.ok(customTool);

        const sales = await salesTool.func({ artistName: 'Queen' });
        assert.deepEqual(sales, [{ TotalSales: 500 }]);
        assert.ok(recordedQueries.some(q => q.includes("ar.Name = 'Queen'")));

        await tracksTool.func({ genreName: 'Rock', limit: 10 });
        assert.ok(recordedQueries.some(q => q.includes("g.Name = 'Rock'") && q.includes('LIMIT 10')));

        const custom = await customTool.func({ naturalLanguageQuery: 'Show me artists' });
        assert.deepEqual(custom, { naturalLanguageQuery: 'Show me artists' });
    });

    test('all tool sets register cleanly into ToolLoader without conflict', () => {
        const fakeDb = { all: async () => [] };
        const loader = new ToolLoader();

        // Executor tools include generator tools
        loader.addTools(executorTools(fakeDb));
        const declarations = loader.getToolDeclarations();
        assert.equal(declarations.length, 3);

        const mainLoader = new ToolLoader();
        mainLoader.addTools(mainAgentTools(fakeDb));
        assert.equal(mainLoader.getToolDeclarations().length, 3);
    });
});
