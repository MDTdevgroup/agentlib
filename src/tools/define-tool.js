import { makeException } from "../util/exception.js";

/**
 * Binds a serializable model-facing tool declaration to an executable implementation.
 *
 * @param {object} declaration - Serializable tool declaration metadata (name, description, parameters).
 * @param {Function} implementation - Async executable procedure following (args, context) => Promise<any>.
 * @returns {object} Fused tool record containing declaration properties, type: 'function', and func.
 * @throws {TypeError} If declaration is invalid, contains an embedded func, or implementation is not a function.
 */
export function defineTool(declaration, implementation) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
        throw new TypeError("Tool declaration must be a non-null object.");
    }

    if ('func' in declaration) {
        throw new TypeError(
            "Tool declaration must not contain a 'func' property. Pass the implementation as the second argument to defineTool."
        );
    }

    if (typeof declaration.name !== 'string' || !declaration.name.trim()) {
        throw new TypeError("Tool declaration requires a non-empty 'name' string.");
    }

    if (declaration.type !== undefined && declaration.type !== 'function') {
        throw new TypeError(
            `Unsupported tool type '${declaration.type}'. defineTool only supports 'function' tools.`
        );
    }

    if (typeof implementation !== 'function') {
        throw new TypeError("Tool implementation must be a function.");
    }

    return {
        ...declaration,
        type: 'function',
        func: implementation,
    };
}

/**
 * Wraps a tool implementation with an argument validator.
 *
 * @param {Function} validateArgs - Validator function (args) => parsedArgs | Promise<parsedArgs> | void.
 * @param {Function} implementation - Implementation function (args, context) => Promise<any>.
 * @returns {Function} Validated tool implementation (args, context) => Promise<any>.
 * @throws {TypeError} If either validateArgs or implementation is not a function.
 */
export function withValidation(validateArgs, implementation) {
    if (typeof validateArgs !== 'function' || typeof implementation !== 'function') {
        throw new TypeError("Both validateArgs and implementation must be functions.");
    }

    return async function validatedImplementation(args, context) {
        let validArgs;
        try {
            validArgs = await validateArgs(args);
        } catch (error) {
            throw makeException(
                'ToolArgumentInvalid',
                error?.message || 'Tool arguments failed validation',
                { cause: error }
            );
        }

        const sanitizedArgs = validArgs !== undefined ? validArgs : args;
        return implementation(sanitizedArgs, context);
    };
}
