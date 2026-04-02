import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { ToolLoader } from "../ToolLoader.js";
import { createTracer, DomainObservability } from "../services/observability.js";

/**
 * The Orchestrator. Manages state, tool execution, and the CPS loop.
 */
export class AgentRunner {
    /**
     * @param {CoreAgent} coreAgent - The stateless LLM executor instance.
     * @param {object} [options={}] - Configuration options for the runner.
     * @param {string} [options.name='agent_runner'] - Identifier name for tracing and logging.
     * @param {EventEmitter} [options.eventEmitter] - Custom event emitter for observability routing.
     * @param {string} [options.logmode='none'] - Determines logging strategy ('none', 'console', 'otel', etc.).
     * @param {ToolLoader} [options.toolLoader=null] - Instance managing available native and remote tools.
     * @param {boolean} [options.enableMCP=false] - Flag to enable the Model Context Protocol for remote tools.
     * @param {boolean} [options.redundantToolInfo=true] - Flag to explicitly inject tool definitions into the system prompt.
     */
    constructor(coreAgent, {
        name = 'agent_runner',
        eventEmitter,
        logmode = 'none',
        toolLoader = null,
        enableMCP = false,
        redundantToolInfo = true,
    } = {}) {

        this.coreAgent = coreAgent;
        this.name = name;
        this.sessionId = uuidv4();
        this.events = eventEmitter || new EventEmitter();
        this.tracer = createTracer(this.events, this.sessionId);

        this.toolLoader = toolLoader || new ToolLoader(enableMCP);
        this.redundantToolInfo = redundantToolInfo;

        if (logmode !== 'none') {
            new DomainObservability(this.events, { mode: logmode });
        }
    }

    /**
     * Initializes the base context with the system prompt and tool descriptions.
     * * @returns {Array<object>} An array containing the initial system message block.
     */
    _buildBaseContext() {
        const allTools = this.toolLoader.getTools();
        const context = [];

        if (this.redundantToolInfo) {
            const toolDescriptions = allTools
                .filter(t => t.name && t.description)
                .map(tool => `${tool.name}: ${tool.description}`)
                .join('; ');

            if (toolDescriptions) {
                context.push({
                    role: 'system',
                    content: `You are a tool-calling agent. You have access to the following tools: ${toolDescriptions}. Use these tools to answer the user's questions.`
                });
            }
        }
        return context;
    }

    /**
     * Entry point to start a new conversation branch.
     * @param {string|object} initialInput - The starting user prompt.
     * @returns {Promise<object>} The resulting CPS turn object for the initial execution.
     */
    async start(initialInput) {
        const baseContext = this._buildBaseContext();
        return await this.next(initialInput, baseContext);
    }

    /**
     * The CPS Loop execution. Processes a turn and returns continuations for future turns.
     * @param {string|object} userInput - The user prompt for this specific turn.
     * @param {Array<object>} previousContext - The immutable message history leading up to this turn.
     * @returns {Promise<object>} A turn object containing the LLM output, executed tools, current context, and continuation callbacks (next/branch).
     */
    async next(userInput, previousContext) {
        return await this.tracer('agent:turn', { input: userInput }, async (turnSpanId) => {

            let activeContext = [...previousContext, userInput];
            const allTools = this.toolLoader.getTools() || [];
            const executed = [];

            let response = await this.coreAgent.execute(activeContext, allTools, this.tracer);

            response.rawResponse.output.forEach(item => {
                if (item.type === "function_call") {
                    const { parsed_arguments, ...rest } = item;
                    const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
                    activeContext.push({ ...rest, arguments: args });
                } else {
                    activeContext.push(item);
                }
            });

            const functionCalls = response.rawResponse.output.filter(item => item.type === "function_call");

            if (functionCalls.length > 0) {
                for (const call of functionCalls) {
                    let args = JSON.parse(call.arguments);
                    call.arguments = args;
                    executed.push(call);

                    const tool = this.toolLoader.findTool(call.name);
                    if (!tool || !tool.func) throw new Error(`Tool ${call.name} missing.`);

                    const result = await this.tracer(`tool:${call.name}`, { args }, async () => {
                        return await tool.func(args);
                    });

                    activeContext.push({
                        name: call.name,
                        call_id: call.call_id,
                        type: "function_call_output",
                        output: JSON.stringify(result),
                    });
                }

                response = await this.coreAgent.execute(activeContext, allTools, this.tracer);

                response.rawResponse.output.forEach(item => activeContext.push(item));
            }

            return {
                message: response.output,
                rawResponse: response.rawResponse,
                executedTools: executed,
                context: activeContext,

                next: async (newInput) => this.next(newInput, activeContext),
                branch: async (alternativeInput) => this.next(alternativeInput, previousContext)
            };
        });
    }
}