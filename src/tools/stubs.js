/**
 * @fileoverview Generates JSDoc-annotated JavaScript stubs from tool declarations.
 * Enables programmatic tool execution inside sandbox environments without
 * requiring TypeScript tooling, compilation, or code-generation packages.
 */

// TODO: extract(value, ExpectedType) helper left out of scope per reference doc recommendation to avoid latency and field dropping.

/**
 * Maps a JSON Schema type to a standard JSDoc type annotation.
 * @param {object} [propSchema={}]
 * @returns {string}
 */
function toJSDocType(propSchema = {}) {
    if (!propSchema || typeof propSchema !== 'object') return 'any';
    const type = propSchema.type;
    switch (type) {
        case 'string':
            return 'string';
        case 'number':
        case 'integer':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'array':
            if (propSchema.items?.type) {
                return `Array<${toJSDocType(propSchema.items)}>`;
            }
            return 'Array<any>';
        case 'object':
            return 'object';
        default:
            return 'any';
    }
}

/**
 * Formats an MCP `outputSchema` into a rich JSDoc return type annotation (up to depth 2).
 * Falls back to `'any'` when no `outputSchema` is provided.
 * @param {object} [schema]
 * @param {number} [depth=0]
 * @returns {string}
 */
function formatOutputSchemaType(schema, depth = 0) {
    if (!schema || typeof schema !== 'object') return 'any';
    if (Array.isArray(schema.enum) && schema.enum.length > 0 && depth <= 2) {
        return schema.enum.map(v => JSON.stringify(v)).join(' | ');
    }
    const type = schema.type;
    switch (type) {
        case 'string':
            return 'string';
        case 'number':
        case 'integer':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'array':
            if (schema.items && typeof schema.items === 'object') {
                return `Array<${formatOutputSchemaType(schema.items, depth)}>`;
            }
            return 'Array<any>';
        case 'object': {
            const props = schema.properties;
            if (!props || typeof props !== 'object' || depth >= 3) {
                return 'object';
            }
            const entries = Object.entries(props);
            if (entries.length === 0) return 'object';
            const reqSet = new Set(Array.isArray(schema.required) ? schema.required : []);
            const fields = entries.map(([key, val]) => {
                const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
                const opt = reqSet.size > 0 && !reqSet.has(key) ? '?' : '';
                return `${safeKey}${opt}: ${formatOutputSchemaType(val, depth + 1)}`;
            });
            return `{ ${fields.join(', ')} }`;
        }
        default:
            return 'any';
    }
}

/**
 * Formats a property name for JSDoc and JavaScript invocation.
 * @param {string} prop
 * @param {boolean} isRequired
 * @returns {string}
 */
function formatPropName(prop, isRequired) {
    const isSafeIdent = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(prop);
    const formatted = isSafeIdent ? `args.${prop}` : `args[${JSON.stringify(prop)}]`;
    return isRequired ? formatted : `[${formatted}]`;
}

/**
 * Generates an executable JSDoc-annotated function stub for a single tool declaration.
 *
 * @param {object} declaration - Tool declaration with name, description, and parameters schema.
 * @returns {string} JSDoc comment and JavaScript async function stub.
 */
export function generateToolStub(declaration) {
    if (!declaration || typeof declaration !== 'object') {
        throw new TypeError("generateToolStub requires a valid tool declaration object.");
    }

    const rawName = declaration.name || declaration.type;
    if (!rawName) {
        throw new Error("Tool declaration is missing a name or type identifier.");
    }

    const description = declaration.description ? declaration.description.trim() : `Invokes the ${rawName} tool.`;
    const params = declaration.parameters || {};
    const properties = params.properties || {};
    const requiredSet = new Set(Array.isArray(params.required) ? params.required : []);

    const lines = [];
    lines.push('/**');
    lines.push(` * ${description.replace(/\*\//g, '* /')}`);
    lines.push(' * @param {object} [args={}]');

    for (const [propName, propSchema] of Object.entries(properties)) {
        const isRequired = requiredSet.has(propName);
        const jsDocType = toJSDocType(propSchema);
        const nameFormatted = formatPropName(propName, isRequired);
        const propDesc = propSchema?.description ? ` - ${propSchema.description.trim().replace(/\*\//g, '* /')}` : '';
        lines.push(` * @param {${jsDocType}} ${nameFormatted}${propDesc}`);
    }

    const returnType = declaration.outputSchema
        ? formatOutputSchemaType(declaration.outputSchema)
        : 'any';
    lines.push(` * @returns {Promise<${returnType}>}`);
    lines.push(' */');

    // Emit function stub
    const isSafeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(rawName);
    if (isSafeName) {
        lines.push(`async function ${rawName}(args = {}) {`);
        lines.push(`    return __callTool(${JSON.stringify(rawName)}, args);`);
        lines.push('}');
    } else {
        // Fallback for names with dashes or special chars
        lines.push(`globalThis[${JSON.stringify(rawName)}] = async function(args = {}) {`);
        lines.push(`    return __callTool(${JSON.stringify(rawName)}, args);`);
        lines.push('};');
    }

    return lines.join('\n');
}

/**
 * Generates combined executable JSDoc stubs for multiple tool declarations.
 *
 * @param {Array<object>} declarations - Array of tool declarations.
 * @returns {string} Concatenated JavaScript stubs code.
 */
export function generateToolStubs(declarations) {
    if (!Array.isArray(declarations)) {
        return '';
    }

    return declarations
        .filter(d => Boolean(d && (d.name || d.type)))
        .map(d => generateToolStub(d))
        .join('\n\n');
}
