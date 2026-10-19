import { Agent, LLMService, defineTool, createSandbox } from '../../index.js';

// Define local domain tools using defineTool(declaration, implementation)
const listEmployeesTool = defineTool(
    {
        name: 'list_employees',
        description: 'List employees in a given department.',
        parameters: {
            type: 'object',
            properties: {
                department: {
                    type: 'string',
                    description: 'Department name (e.g., "engineering", "sales")',
                },
            },
            required: ['department'],
        },
    },
    async ({ department }) => {
        const roster = {
            engineering: [
                { id: 'emp_1', name: 'Ada Lovelace', role: 'Principal Engineer' },
                { id: 'emp_2', name: 'Grace Hopper', role: 'Staff Engineer' },
                { id: 'emp_3', name: 'Alan Turing', role: 'Senior Engineer' },
            ],
            sales: [
                { id: 'emp_4', name: 'Katherine Johnson', role: 'Account Executive' },
            ],
        };
        return roster[department.toLowerCase()] || [];
    }
);

const getTimesheetTool = defineTool(
    {
        name: 'get_timesheet',
        description: 'Fetch weekly logged hours and project breakdown for an employee ID.',
        parameters: {
            type: 'object',
            properties: {
                employeeId: {
                    type: 'string',
                    description: 'The employee identifier (e.g., "emp_1")',
                },
            },
            required: ['employeeId'],
        },
    },
    async ({ employeeId }) => {
        const sheets = {
            emp_1: { employeeId: 'emp_1', hours: 44, overtime: 4, project: 'Compiler Core' },
            emp_2: { employeeId: 'emp_2', hours: 38, overtime: 0, project: 'Linker' },
            emp_3: { employeeId: 'emp_3', hours: 46, overtime: 6, project: 'Enigma' },
            emp_4: { employeeId: 'emp_4', hours: 40, overtime: 0, project: 'Enterprise Q4' },
        };
        return sheets[employeeId] || { employeeId, hours: 0, overtime: 0, project: 'Unassigned' };
    }
);

async function run() {
    const llm = new LLMService({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
    });

    const agent = new Agent(llm, {
        name: 'CodeModeAnalyst',
        model: 'gpt-4o-mini',
        toolExposure: 'auto',
        codeMode: true,
        sandbox: createSandbox({
            type: 'worker',
            timeoutMS: 5000,
        }),
        tools: [listEmployeesTool, getTimesheetTool],
        approveToolCall: async ({ name, origin }) => {
            console.log(`[Auth] Approving tool "${name}" (origin: ${origin})`);
            return true;
        },
    });

    agent.addInput({
        role: 'system',
        content: [
            'You are an engineering operations assistant with access to run_tool_script.',
            'When asked to aggregate or filter across multiple records, prefer calling run_tool_script',
            'to fetch and filter data in a single JavaScript script rather than making separate tool turns.',
        ].join(' '),
    });

    agent.addInput({
        role: 'user',
        content: 'Find all engineering employees who logged overtime hours this week and return their names, projects, and overtime hours.',
    });

    console.log('Running Code Mode agent...\n');
    const history = await agent.run();

    const finalTurn = history[history.length - 1];
    console.log('\n=== Final Answer ===');
    console.log(finalTurn.output);
}

run().catch((err) => {
    console.error('Error in Code Mode example:', err);
    process.exitCode = 1;
});
