import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateToolStub, generateToolStubs } from '../src/tools/stubs.js';

describe('Tool Stub Generator (generateToolStub & generateToolStubs)', () => {

    describe('generateToolStub', () => {
        test('generates JSDoc and async function stub for a standard declaration', () => {
            const declaration = {
                name: 'calculate_tax',
                description: 'Calculates sales tax for an order amount.',
                parameters: {
                    type: 'object',
                    properties: {
                        amount: {
                            type: 'number',
                            description: 'The net order total.',
                        },
                        state: {
                            type: 'string',
                            description: 'Two-letter state code.',
                        },
                        exempt: {
                            type: 'boolean',
                            description: 'Whether customer is tax exempt.',
                        },
                    },
                    required: ['amount', 'state'],
                },
            };

            const stub = generateToolStub(declaration);

            assert.match(stub, /\* Calculates sales tax for an order amount\./);
            assert.match(stub, /\* @param {number} args\.amount - The net order total\./);
            assert.match(stub, /\* @param {string} args\.state - Two-letter state code\./);
            assert.match(stub, /\* @param {boolean} \[args\.exempt\] - Whether customer is tax exempt\./);
            assert.match(stub, /\* @returns {Promise<any>}/);
            assert.match(stub, /async function calculate_tax\(args = \{\}\) \{/);
            assert.match(stub, /return __callTool\("calculate_tax", args\);/);
        });

        test('handles array and object parameter types in JSDoc', () => {
            const declaration = {
                name: 'process_batch',
                parameters: {
                    type: 'object',
                    properties: {
                        tags: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                        ids: {
                            type: 'array',
                        },
                        config: {
                            type: 'object',
                        },
                        unknownField: {
                            type: 'unrecognized',
                        },
                    },
                    required: ['tags'],
                },
            };

            const stub = generateToolStub(declaration);

            assert.match(stub, /@param {Array<string>} args\.tags/);
            assert.match(stub, /@param {Array<any>} \[args\.ids\]/);
            assert.match(stub, /@param {object} \[args\.config\]/);
            assert.match(stub, /@param {any} \[args\.unknownField\]/);
        });

        test('escapes comment closing delimiters */ in descriptions', () => {
            const declaration = {
                name: 'safe_tool',
                description: 'A tool that mentions */ in comments',
                parameters: {
                    type: 'object',
                    properties: {
                        code: {
                            type: 'string',
                            description: 'code with */ inside',
                        },
                    },
                },
            };

            const stub = generateToolStub(declaration);

            assert.ok(stub.includes('* / in comments'));
            assert.ok(stub.includes('code with * / inside'));
        });

        test('falls back to globalThis assignment for tool names with special characters or hyphens', () => {
            const declaration = {
                name: 'fetch-user-data',
                description: 'Fetches user info',
            };

            const stub = generateToolStub(declaration);

            assert.match(stub, /globalThis\["fetch-user-data"\] = async function\(args = \{\}\) \{/);
            assert.match(stub, /return __callTool\("fetch-user-data", args\);/);
        });

        test('throws TypeError on non-object declaration', () => {
            assert.throws(() => generateToolStub(null), {
                name: 'TypeError',
            });
            assert.throws(() => generateToolStub('invalid'), {
                name: 'TypeError',
            });
        });

        test('throws Error when declaration has no name or type', () => {
            assert.throws(() => generateToolStub({ description: 'missing name' }), {
                name: 'Error',
                message: /missing a name or type/i,
            });
        });
    });

    describe('generateToolStubs', () => {
        test('concatenates multiple stubs with separation', () => {
            const decls = [
                { name: 'toolA', description: 'Tool A' },
                { name: 'toolB', description: 'Tool B' },
            ];

            const combined = generateToolStubs(decls);

            assert.match(combined, /async function toolA/);
            assert.match(combined, /async function toolB/);
            assert.ok(combined.includes('Tool A'));
            assert.ok(combined.includes('Tool B'));
        });

        test('returns empty string on non-array or empty input', () => {
            assert.equal(generateToolStubs(null), '');
            assert.equal(generateToolStubs([]), '');
            assert.equal(generateToolStubs('invalid'), '');
        });

        test('filters out invalid or empty entries in declarations array', () => {
            const decls = [
                null,
                { name: 'validTool' },
                undefined,
                {},
            ];

            const combined = generateToolStubs(decls);

            assert.match(combined, /async function validTool/);
            assert.doesNotMatch(combined, /undefined/);
        });
    });
});
