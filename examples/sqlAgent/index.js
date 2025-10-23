import { Agent } from "../../src/Agent.js";
import { initDB, generatorTools, executorTools } from "./sqlTools.js";
import readline from "readline";
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

// Define the output schema for the executor agent
const executorOutputSchema = z.object({
  sql_output: z.array(
    z.array(
      z.object({
        column: z.string(),
        value: z.union([z.string(), z.number()]),
      })
    )
  ).describe("The raw results from the SQL query execution"),
  explanation_summary: z.string().describe("A clear explanation of what the query does and a summary of the key findings from the results, including sample data")
});

async function main() {
  console.log("Welcome to the SQL Agent!");
  console.log("--------------------------------");
  const db = await initDB("./chinook.db");
  const genTools = generatorTools(db);
  const execTools = executorTools(db);

  const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table';");
  console.log("### Tables:", tables.map(t => t.name));
  console.log("--------------------------------");

  const generatorAgent = new Agent('openai', process.env.OPENAI_API_KEY, {model: "gpt-5-mini", tools: genTools });
  generatorAgent.addInput({
    role: "system",
    content: `You are a helpful SQL generator.
    - Only propose a single SELECT query as your final answer.
    - Use the provided tools (list_tables, get_schema) to explore the schema as needed.
    - Do NOT execute queries.
    - When you are done, reply with ONLY the SQL query, no explanations.`
  });

  const executorAgent = new Agent('openai', process.env.OPENAI_API_KEY, { 
    model: "gpt-5-mini", 
    tools: execTools, 
    outputSchema: executorOutputSchema 
  });
  executorAgent.addInput({
    role: "system",
    content: `You are a SQL expert with a strong attention to detail.
      Validate the SQL, fix mistakes if needed, and then call run_query.
      
      After executing the query, you must provide your response in the following format:
      - sql_output: The raw results from the SQL query execution
      - explanation_summary: A clear explanation of what the query does and a summary of the key findings from the results, including sample data if available
      
      Make sure to analyze the results and provide meaningful insights about what the data shows.`
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  async function ask() {
    rl.question("Agent: What would you like to do? (type 'quit' to exit)\nUser: ", async (answer) => {
      if (answer.toLowerCase() === "quit") {
        rl.close();
        process.exit(0);
      }
      console.log("--------------------------------");

      generatorAgent.addInput({ role: "user", content: answer });

      console.log("===RUNNING GENERATOR AGENT===");
      // Run generator agent
      for (let i = 0; i < 10; i++) {
        const step = await generatorAgent.run();
        const hasFunctionCall = step.rawResponse.output.some(item => item.type === "function_call");
        if (!hasFunctionCall) {
          console.log("\n===Generated Query===");
          const query = step.output;
          console.log(query + "\n");
          await validateAndExecute(query);
          break;
        } else {
          step.rawResponse.output.forEach(item => {
            if (item.type === "function_call") {
              console.log(`Tool Executed:`, item.name);
            }
          })
        }
      }

      // loop back
      ask();
    });
  }

  async function validateAndExecute(query) {
    console.log("--------------------------------");
    console.log("===RUNNING EXECUTOR AGENT===\n");
    executorAgent.addInput({
      role: "user",
      content: `Validate and then execute this SQL query: ${query}`
    });

    for (let i = 0; i < 12; i++) {
      const step = await executorAgent.run();
      const hasFunctionCall = step.rawResponse.output.some(item => item.type === "function_call");
      if (hasFunctionCall) {
        step.rawResponse.output.forEach(item => {
          if (item.type === "function_call") {
            console.log(`Tool Executed:`, item.name);
          }
        });
      } else {
        // No more function calls, process the structured output
        try {
          const parsedOutput = step.output;
          console.log("\n=== SQL Query Results ===");
          console.log("Raw Output:", JSON.stringify(parsedOutput.sql_output, null, 2));
          console.log("\n=== Analysis & Summary ===");
          console.log(parsedOutput.explanation_summary);
          console.log("--------------------------------\n");
        } catch (error) {
          console.log("Final Answer:", step.output);
          console.log("--------------------------------\n");
        }
        break;
      }
    }
  }
  ask();
}

main();
