import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { createTracer, DomainObservability } from "../services/observability.js";
import { Context } from "../memory/context.js";
import { defaultMaxTurns } from "../config.js";

/**
 * A generalized Runner that orchestrates the outer multi-turn loop
 * and handles the Continuation-Passing Style (CPS) snapshotting automatically.
 */
export class AgentRunner {
    /**
     * @param {Agent|Array<Agent>|Record<string, Agent>} agents - A configured Agent instance, Array, or dictionary of Agents.
     * @param {object} [options={}] - Runner-specific configuration options.
     * @param {string} [options.name='agent_runner'] - Identifier for tracing and logging.
     * @param {EventEmitter} [options.eventEmitter] - Custom event emitter.
     * @param {string} [options.logmode='none'] - Logging strategy.
     * @param {number} [options.maxTurns=5] - Maximum number of outer macro turns allowed.
     * @param {Function} [options.turnStrategy] - A user-defined function for driving turns.
     */
    constructor(agents, {
        name = 'agent_runner',
        eventEmitter,
        logmode = 'none',
        maxTurns = defaultMaxTurns,
        turnStrategy = null,
    } = {}) {
        if (typeof agents === 'object' && !Array.isArray(agents) && !(agents.run)) {
            this.agents = agents;
            Object.entries(agents).forEach(([key, agent]) => {
                if (agent.name === 'agent') agent.name = key;
            });
        } else if (Array.isArray(agents)) {
            this.agents = {};
            agents.forEach((agent, i) => {
                const key = agent.name === 'agent' ? `agent_${i + 1}` : agent.name;
                agent.name = key;
                this.agents[key] = agent;
            });
        } else {
            this.agents = { [agents.name]: agents };
        }

        // Default strategy for backward compatibility
        if (!turnStrategy) {
            this.turnStrategy = async (agentDict, turn, currentState) => {
                const agent = Object.values(agentDict)[0];
                let activeState = currentState;
                if (turn === 1 && currentState && !(currentState instanceof Context)) {
                    activeState = new Context([currentState]);
                }
                const res = await agent.run(activeState);
                return {
                    output: res.output,
                    executedTools: res.executedTools,
                    rawResponse: res.rawResponse,
                    newContext: res.newContext,
                    isSatisfied: true // In single agent mode without custom strategy, one fully finished turn satisfies the loop
                };
            };
        } else {
            // turnStrategy returns {
            //     output: "The final string message or output",
            //     executedTools: [], // Array of tools that were run during the turn
            //     rawResponse: {},  // Complete underlying provider response 
            //     newContext: Context, // The updated context state
            //     isSatisfied: Boolean // Loop termination flag 
            // }
            this.turnStrategy = turnStrategy;
        }

        this.name = name;
        this.sessionId = uuidv4();
        this.events = eventEmitter || new EventEmitter();
        this.tracer = createTracer(this.events, this.sessionId);
        this.maxTurns = maxTurns;

        if (logmode !== 'none') {
            new DomainObservability(this.events, { mode: logmode });
        }
    }

    /**
     * Starts the conversation loop.
     * @param {string|object} [initialInput] - The starting user prompt for single agent backward compatibility.
     */
    async run(initialInput = null) {
        const history = [];
        const normInput = initialInput ? this._normalizeInput(initialInput) : null;
        await this._runLoop(1, history, normInput);
        return history;
    }

    // Fallback for executeTask for backward compatibility
    async executeTask(userInput) {
        return await this.run(userInput);
    }

    _normalizeInput(input) {
        if (typeof input === 'string') return { role: 'user', content: input };
        if (input && typeof input === 'object' && input.role && input.content) return input;
        throw new Error('Input must be a string or an object with { role, content }.');
    }

    /**
     * The internal recursive loop that acts as the CPS driver.
     */
    async _runLoop(turn, history, currentState = null) {
        await this._executeTurn(turn, currentState, async (result) => {
            history.push(result);

            // Outer loop exit conditions
            if (result.isSatisfied) {
                return;
            }
            if (turn >= this.maxTurns) {
                return;
            }

            // Continue the outer loop
            await this._runLoop(turn + 1, history, result.newContext);
        });
    }

    /**
     * Executes a single turn, uses the current state, and passes the 
     * continuation (k) to allow time-travel / branching.
     */
    async _executeTurn(turn, currentState, k) {
        return await this.tracer('agent_runner:turn', { turn }, async () => {
            // 1. Run the user-provided turn strategy 
            // This is where agent.run(currentState) happens (the inner loop)
            const turnData = await this.turnStrategy(this.agents, turn, currentState);

            // 2. Package the result with a resume() function for the CPS branching
            await k({
                turn,
                ...turnData,
                resume: async (newContinuation) => {
                    // Re-run this exact turn branching into the new continuation
                    await this._executeTurn(turn, currentState, newContinuation);
                }
            });
        });
    }
}