import { ToolLoader } from '../../index.js';

const webSearchTool = {
    type: "web_search"
};

const exitLoopTool = {
    type: "function",
    name: 'exit_loop',
    description: 'Call this tool when the travel agent finally gives you a satisfactory vacation plan that addresses all your complaints. This ends the conversation.',
    parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why are you finally satisfied?' } },
        required: ['reason']
    },
    func: async (args) => {
        console.log(`\nGrumpy Traveler is satisfied: "${args.reason}"`);
        return "CONVERSATION ENDED";
    }
};

const travelAgentToolLoader = new ToolLoader();
travelAgentToolLoader.addTool(webSearchTool);

const grumpyTravelerToolLoader = new ToolLoader();
grumpyTravelerToolLoader.addTool(exitLoopTool);

export { travelAgentToolLoader, grumpyTravelerToolLoader };