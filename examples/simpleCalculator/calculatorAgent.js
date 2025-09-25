import { Agent } from '../../src/Agent.js';

// Calculator tool functions
const calculatorTools = [
  {
    type: "function",
    name: "add",
    description: "Add two numbers together",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" }
      },
      required: ["a", "b"]
    },
    func: async (args) => {
      console.log(`Adding ${args.a} + ${args.b}...`);
      // Simulate some processing time
      await new Promise(resolve => setTimeout(resolve, 1000));
      const result = args.a + args.b;
      console.log(`Result: ${result}`);
      return result;
    }
  },
  {
    type: "function",
    name: "subtract",
    description: "Subtract second number from first number",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number to subtract" }
      },
      required: ["a", "b"]
    },
    func: async (args) => {
      console.log(`Subtracting ${args.a} - ${args.b}...`);
      // Simulate some processing time
      await new Promise(resolve => setTimeout(resolve, 800));
      const result = args.a - args.b;
      console.log(`Result: ${result}`);
      return result;
    }
  },
  {
    type: "function",
    name: "multiply",
    description: "Multiply two numbers together",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" }
      },
      required: ["a", "b"]
    },
    func: async (args) => {
      console.log(`Multiplying ${args.a} × ${args.b}...`);
      // Simulate some processing time
      await new Promise(resolve => setTimeout(resolve, 1200));
      const result = args.a * args.b;
      console.log(`Result: ${result}`);
      return result;
    }
  },
  {
    type: "function",
    name: "divide",
    description: "Divide first number by second number",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number (dividend)" },
        b: { type: "number", description: "Second number (divisor)" }
      },
      required: ["a", "b"]
    },
    func: async (args) => {
      console.log(`Dividing ${args.a} ÷ ${args.b}...`);
      if (args.b === 0) {
        throw new Error("Cannot divide by zero");
      }
      // Simulate some processing time
      await new Promise(resolve => setTimeout(resolve, 900));
      const result = args.a / args.b;
      console.log(`Result: ${result}`);
      return result;
    }
  },
  {
    type: "function",
    name: "sleep",
    description: "Sleep for a specified number of milliseconds",
    parameters: {
      type: "object",
      properties: {
        milliseconds: { type: "number", description: "Number of milliseconds to sleep" }
      },
      required: ["milliseconds"]
    },
    func: async (args) => {
      console.log(`Sleeping for ${args.milliseconds}ms...`);
      await new Promise(resolve => setTimeout(resolve, args.milliseconds));
      console.log(`Woke up after ${args.milliseconds}ms`);
      return `Slept for ${args.milliseconds}ms`;
    }
  }
];

// Create calculator agent
const calculatorAgent = new Agent({tools: calculatorTools});

// Example usage function
export async function runCalculatorExample() {
  console.log("Starting Calculator Agent Example");
  console.log("=====================================\n");

  // Example 1: Simple calculation
  console.log("Example 1: Simple Addition");
  calculatorAgent.addInput({role: "user", content: "Please add 15 and 27 together"});
  
  const result1 = await calculatorAgent.run();
  console.log("Agent response:", result1);
  console.log("");

  // Example 2: Multiple operations with sleep
  console.log("Example 2: Multiple Operations with Sleep");
  calculatorAgent.addInput({role: "user", content: "Calculate 10 * 5, then sleep for 2 seconds, then subtract 20 from the result"});
  
  const result2 = await calculatorAgent.run();
  console.log("Agent response:", result2);
  console.log("");

  // Example 3: Complex calculation chain
  console.log("Example 3: Complex Calculation Chain");
  calculatorAgent.addInput({role: "user", content: "Calculate (100 + 50) * 2, sleep for 1 second, then divide by 10"});
  
  const result3 = await calculatorAgent.run();
  console.log("Agent response:", result3);
  console.log("");

  // Example 4: Demonstrate concurrency with parallel operations
  console.log("Example 4: Demonstrating Concurrency");
  calculatorAgent.addInput({role: "user", content: "Add 5 and 3, multiply 4 and 6, and sleep for 1 second. Do these operations and tell me all results."});
  
  const result4 = await calculatorAgent.run();
  console.log("Agent response:", result4);
  console.log("");

  console.log("Calculator Agent Example Complete!");
}

// Example of running multiple agents concurrently
export async function runConcurrentCalculators() {
  console.log("Running Multiple Calculator Agents Concurrently");
  console.log("==================================================\n");

  const agents = [
    new Agent({tools: calculatorTools}),
    new Agent({tools: calculatorTools}),
    new Agent({tools: calculatorTools})
  ];

  // Set up different tasks for each agent
  const tasks = [
    "Calculate 25 + 15 and sleep for 1 second",
    "Calculate 10 * 8 and sleep for 2 seconds", 
    "Calculate 100 / 4 and sleep for 1.5 seconds"
  ];

  // Start all agents concurrently
  const startTime = Date.now();
  const promises = agents.map((agent, index) => {
    agent.addInput({role: "user", content: tasks[index]});
    return agent.run();
  });

  try {
    const results = await Promise.all(promises);
    const endTime = Date.now();
    
    console.log("Concurrent Execution Results:");
    results.forEach((result, index) => {
      console.log(`Agent ${index + 1}: ${JSON.stringify(result)}`);
    });
  
    console.log("\nNote: Without parallel tool calls, operations run sequentially");
    
  } catch (error) {
    console.error("Error in concurrent execution:", error);
  }
}

// Export the agent and tools for external use
export { calculatorAgent, calculatorTools };

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Running Calculator Agent Examples...\n");
  
  // Run sequential examples
  await runCalculatorExample();
  console.log("\n" + "=".repeat(50) + "\n");
  
  // Run concurrent examples
  await runConcurrentCalculators();
}
