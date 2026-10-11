import { Agent, LLMService } from '../../index.js';

// Tool Declaration
const printMessageTool = {
    name: 'printMessage',
    description: 'Return a message to the user.',
    parameters: {
        type: 'object',
        properties: {
            message: {
                type: 'string',
                description: 'The message to return.'
            }
        },
        required: ['message']
    },
    func: async ({ message }) => {
        return message;
    },
};


const llm = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });

const agent = new Agent(llm, {
    tools: [printMessageTool]
});

agent.addInput({ role: "user", content: "Use the print message tool to print return a random message." });

const turn = await agent.start()

// Debug logging - uncomment if needed
// console.log(turn)
// console.log(turn.context)

// Look for function calls in the context object
for (const m of turn.context.messages) {
    if (m.type === 'function_call_output') {
        // Do whatever you want with the function output
        console.log(m.output)
    }
}
