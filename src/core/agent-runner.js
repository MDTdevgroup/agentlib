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

        /**
         * @callback turnStrategy
         * @param {Object.<string, Agent>} agentDict - A map of agent keys to Agent instances.
         * @param {Object.<string, Context>} agentContexts - A map of agent keys to Context instances.
         * @param {number} turnNumber - The current iteration index (starting from 1).
         * @returns {Promise<{
         *   output: string,
         *   executedTools: Array,
         *   rawResponse: Object,
         *   contextSnapshot: Object,
         *   isSatisfied: boolean
         * }>}
         */
        if (!turnStrategy) { // Run last agent in the dictionary by default
            this.turnStrategy = async (agentDict, agentContexts, turnNumber) => {
                const agent = Object.values(agentDict).at(-1);
                const res = await agent.run(agentContexts[agent.name] || null);
                const updatedContexts = { ...agentContexts, [agent.name]: res.context };

                return {
                    output: res.output,
                    executedTools: res.executedTools,
                    rawResponse: res.rawResponse,
                    contextSnapshot: updatedContexts,
                    isSatisfied: true
                };
            };
        } else {
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
     * Starts the conversation and pauses immediately after the first turn.
     */
    async start(initialInput = null, options = {}) {
        const normInput = initialInput ? this._normalizeInput(initialInput) : {};
        const limit = options.maxTurns || this.maxTurns;
        return this._executeTurn(1, normInput, limit);
    }

    /**
     * Executes the entire agent system loop until completion.
     * @param {string|object} [initialInput] - The starting user prompt.
     */
    async run(initialInput = null, options = {}) {
        const history = [];
        const normInput = initialInput ? this._normalizeInput(initialInput) : {};
        const limit = options.maxTurns || this.maxTurns;

        let currentTurn = await this._executeTurn(1, normInput, limit);
        history.push(currentTurn);

        while (!currentTurn.isDone) {
            currentTurn = await currentTurn.next();
            history.push(currentTurn);
        }

        return history;
    }

    /**
     * Time Travel: Branches from a historical turn with a modified context,
     * and automatically runs the new branch to completion.
     */
    async branch(turn, overrideContexts, options = {}) {
        const branchHistory = [turn];
        const limit = options.maxTurns || this.maxTurns;

        // "Refuel" the branch execution
        let currentTurn = await turn.next(overrideContexts, { maxTurns: limit });
        branchHistory.push(currentTurn);

        while (!currentTurn.isDone) {
            currentTurn = await currentTurn.next();
            branchHistory.push(currentTurn);
        }
        return branchHistory;
    }

    _normalizeInput(input) {
        if (typeof input === 'string') return { role: 'user', content: input };
        if (input && typeof input === 'object' && input.role && input.content) return input;
        throw new Error('AgentRunner.run() initialInput must be a string or an object with { role, content }.');
    }

    /**
     * @param {number} turnNumber - The absolute index in history.
     * @param {object} agentContexts - The current state.
     * @param {number} remainingTurns - How many more steps are allowed in this run.
     */
    async _executeTurn(turnNumber, agentContexts, remainingTurns) {
        return await this.tracer('agent_runner:turn', { turnNumber }, async () => {
            const turnData = await this.turnStrategy(this.agents, agentContexts, turnNumber);

            // Logic: Stop if agent is satisfied OR we ran out of "fuel"
            const isDone = turnData.isSatisfied || remainingTurns <= 1;
            const frozenContexts = Object.freeze(turnData.contextSnapshot);

            return {
                turn: turnNumber,
                isDone,
                ...turnData,
                contextSnapshot: frozenContexts,

                next: async (overrideContexts = null, options = {}) => {
                    const nextState = overrideContexts || frozenContexts;

                    // If the user passes a NEW maxTurns, we reset the gauge (Refuel)
                    // Otherwise, we just decrement the current gauge
                    const nextRemaining = options.maxTurns || (remainingTurns - 1);

                    const safeNextState = {};
                    for (const [agentName, contextObj] of Object.entries(nextState)) {
                        if (contextObj && typeof contextObj.clone === 'function') {
                            safeNextState[agentName] = contextObj.clone();
                        } else {
                            safeNextState[agentName] = structuredClone(contextObj);
                        }
                    }

                    return this._executeTurn(turnNumber + 1, safeNextState, nextRemaining);
                }
            };
        });
    }
}