import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool, withValidation } from '../src/tools/define-tool.js';
import { isException } from '../src/util/exception.js';

describe('Tool Authoring API (defineTool & withValidation)', () => {

    describe('defineTool', () => {
        test('binds declaration and implementation into fused record with type function', () => {
            const declaration = {
                name: 'get_weather',
                description: 'Get weather for a city',
                parameters: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city'],
                },
            };
            const implementation = async ({ city }) => ({ city, temp: 72 });

            const tool = defineTool(declaration, implementation);

            assert.equal(tool.name, 'get_weather');
            assert.equal(tool.description, 'Get weather for a city');
            assert.deepEqual(tool.parameters, declaration.parameters);
            assert.equal(tool.type, 'function');
            assert.equal(typeof tool.func, 'function');
        });

        test('preserves explicit type: function in declaration', () => {
            const tool = defineTool(
                { type: 'function', name: 'ping', description: 'Ping' },
                async () => 'pong'
            );
            assert.equal(tool.type, 'function');
            assert.equal(tool.name, 'ping');
        });

        test('implementation receives both args and context including signal', async () => {
            let receivedArgs = null;
            let receivedContext = null;
            const controller = new AbortController();

            const tool = defineTool(
                { name: 'test_ctx' },
                async (args, context) => {
                    receivedArgs = args;
                    receivedContext = context;
                    return 'ok';
                }
            );

            const result = await tool.func({ x: 10 }, { signal: controller.signal, extra: 'abc' });
            assert.equal(result, 'ok');
            assert.deepEqual(receivedArgs, { x: 10 });
            assert.equal(receivedContext.signal, controller.signal);
            assert.equal(receivedContext.extra, 'abc');
        });

        test('rejects missing or non-object declaration', () => {
            assert.throws(() => defineTool(null, async () => {}), {
                name: 'TypeError',
                message: /Tool declaration must be a non-null object/,
            });
            assert.throws(() => defineTool(undefined, async () => {}), {
                name: 'TypeError',
            });
            assert.throws(() => defineTool('string', async () => {}), {
                name: 'TypeError',
            });
            assert.throws(() => defineTool([1, 2], async () => {}), {
                name: 'TypeError',
            });
        });

        test('rejects declaration containing embedded func', () => {
            assert.throws(
                () => defineTool({ name: 'calc', func: () => {} }, async () => {}),
                {
                    name: 'TypeError',
                    message: /Tool declaration must not contain a 'func' property/,
                }
            );
        });

        test('rejects missing or empty tool name', () => {
            assert.throws(() => defineTool({}, async () => {}), {
                name: 'TypeError',
                message: /Tool declaration requires a non-empty 'name' string/,
            });
            assert.throws(() => defineTool({ name: '   ' }, async () => {}), {
                name: 'TypeError',
            });
            assert.throws(() => defineTool({ name: 123 }, async () => {}), {
                name: 'TypeError',
            });
        });

        test('rejects types other than function', () => {
            assert.throws(
                () => defineTool({ type: 'web_search', name: 'search' }, async () => {}),
                {
                    name: 'TypeError',
                    message: /Unsupported tool type 'web_search'/,
                }
            );
        });

        test('rejects non-function implementation', () => {
            assert.throws(
                () => defineTool({ name: 'calc' }, null),
                {
                    name: 'TypeError',
                    message: /Tool implementation must be a function/,
                }
            );
            assert.throws(
                () => defineTool({ name: 'calc' }, 'not-a-func'),
                {
                    name: 'TypeError',
                }
            );
        });
    });

    describe('withValidation', () => {
        test('rejects non-function validator or implementation', () => {
            assert.throws(() => withValidation(null, async () => {}), {
                name: 'TypeError',
                message: /Both validateArgs and implementation must be functions/,
            });
            assert.throws(() => withValidation(() => {}, null), {
                name: 'TypeError',
            });
        });

        test('executes sync validator and passes returned/transformed args', async () => {
            const validator = (args) => {
                if (typeof args.val !== 'number') throw new Error('val must be number');
                return { val: args.val * 2 };
            };
            const implementation = async (args) => args.val + 1;

            const wrapped = withValidation(validator, implementation);
            const result = await wrapped({ val: 5 });
            assert.equal(result, 11);
        });

        test('executes async validator and passes returned args', async () => {
            const validator = async (args) => {
                await Promise.resolve();
                return { normalized: args.input.trim().toLowerCase() };
            };
            const implementation = async (args) => args.normalized;

            const wrapped = withValidation(validator, implementation);
            const result = await wrapped({ input: '  HELLO  ' });
            assert.equal(result, 'hello');
        });

        test('passes original args when validator returns void/undefined (assertion style)', async () => {
            const validator = (args) => {
                if (!args.city) throw new Error('city required');
                // Returns undefined
            };
            const implementation = async (args) => `City: ${args.city}`;

            const wrapped = withValidation(validator, implementation);
            const result = await wrapped({ city: 'London' });
            assert.equal(result, 'City: London');
        });

        test('wraps synchronous validator error in ToolArgumentInvalid Exception preserving cause', async () => {
            const originalErr = new Error('Invalid city name');
            const validator = () => {
                throw originalErr;
            };
            const implementation = async () => 'ok';

            const wrapped = withValidation(validator, implementation);

            await assert.rejects(
                async () => wrapped({ city: '' }),
                (err) => {
                    assert.ok(isException(err), 'Must be structured Exception');
                    assert.equal(err.type, 'ToolArgumentInvalid');
                    assert.ok(err.message.includes('Invalid city name'));
                    assert.equal(err.cause, originalErr, 'Must preserve original error as cause');
                    return true;
                }
            );
        });

        test('wraps asynchronous validator rejection in ToolArgumentInvalid Exception preserving cause', async () => {
            const originalErr = new Error('Async validation failed');
            const validator = async () => {
                throw originalErr;
            };
            const implementation = async () => 'ok';

            const wrapped = withValidation(validator, implementation);

            await assert.rejects(
                async () => wrapped({}),
                (err) => {
                    assert.ok(isException(err), 'Must be structured Exception');
                    assert.equal(err.type, 'ToolArgumentInvalid');
                    assert.equal(err.cause, originalErr);
                    return true;
                }
            );
        });

        test('does NOT wrap implementation errors in ToolArgumentInvalid', async () => {
            const validator = (args) => args;
            const implError = new Error('Database connection failed');
            const implementation = async () => {
                throw implError;
            };

            const wrapped = withValidation(validator, implementation);

            await assert.rejects(
                async () => wrapped({}),
                (err) => {
                    assert.equal(err, implError, 'Must rethrow original implementation error');
                    assert.equal(err.type, undefined);
                    return true;
                }
            );
        });

        test('forwards context and AbortSignal through wrapper', async () => {
            const controller = new AbortController();
            let forwardedContext = null;

            const validator = (args) => args;
            const implementation = async (_args, context) => {
                forwardedContext = context;
                return 'done';
            };

            const wrapped = withValidation(validator, implementation);
            await wrapped({ a: 1 }, { signal: controller.signal, user: 'test' });

            assert.ok(forwardedContext);
            assert.equal(forwardedContext.signal, controller.signal);
            assert.equal(forwardedContext.user, 'test');
        });
    });
});
