import { Agent } from "../../src/Agent.js";
import { LLMService } from "../../src/llmService.js";
import { initDB, generatorTools, executorTools, mainAgentTools, getSalesForArtist, getTopTracksInGenre } from "./sqlTools.js";
import readline from "readline";
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const llmService = new LLMService('gemini', process.env.GEMINI_API_KEY);

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
  console.log("Agent: What would you like to do? (type 'quit' to exit)");
  const db = await initDB("./chinook.db");
  const genTools = generatorTools(db);
  const execTools = executorTools(db);

  const sqlGeneratorAgent = new Agent(llmService, { tools: genTools });
  sqlGeneratorAgent.addInput({
    role: "system",
    content: `You are a helpful SQL generator.
    - Only propose a single SELECT query as your final answer.
    - Use the provided tools (list_tables, get_schema) to explore the schema as needed.
    - Do NOT execute queries.
    - When you are done, reply with ONLY the SQL query, no explanations.`
  });

  const sqlExecutorAgent = new Agent(llmService, {
    tools: execTools,
    outputSchema: executorOutputSchema
  });
  sqlExecutorAgent.addInput({
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

  const mainAgent = new Agent(llmService, {
    tools: mainAgentTools(db),
  });

  mainAgent.addInput({
    role: "system",
    content: `
      You are a routing assistant that MUST call a tool for every user request. You have NO direct access to any database or knowledge about the data.

      CRITICAL RULES:
      1. You MUST ALWAYS call one of the provided tools - NEVER answer directly
      2. You do NOT know any data - you can ONLY access data through tools
      3. For requests about "top tracks" or "best tracks" in a genre, use 'find_top_tracks_in_genre'
      4. For requests about artist sales or revenue, use 'find_sales_for_artist'
      5. For complex queries that don't fit the above, use 'generate_custom_sql_query'
      6. NEVER provide data, numbers, or answers without calling a tool first

      Example: "get top 5 rock tracks" → call find_top_tracks_in_genre with genreName="Rock" and limit=5

      If you answer without calling a tool, you are violating your core function.`
  });

  async function ask() {
    rl.question("\nUser: ", async (answer) => {
      if (answer.toLowerCase() === "quit") {
        rl.close();
        process.exit(0);
      }
      console.log("--------------------------------");

      mainAgent.addInput({ role: "user", content: answer });

      console.log("===RUNNING MAIN (ROUTER) AGENT===");
      const response = await mainAgent.run();

      console.log("executed: ", response.executed);
      if (!response.executed) {
        console.log(response.output);
        ask();
        return;
      }

      for (const item of response.executed) {
        const functionName = item.name;
        console.log(`Router decided to use tool: ${functionName}`);
        if (functionName === "generate_custom_sql_query") {
          await runSqlGenerator(answer);
        }
      }

      console.log(response.output)

      // loop back
      ask();
    });
  }

  async function runSqlGenerator(queryPrompt) {
    console.log("--------------------------------");
    console.log("===RUNNING SQL GENERATOR AGENT===");
    sqlGeneratorAgent.addInput({ role: "user", content: queryPrompt });

    // Run generator agent
    for (let i = 0; i < 10; i++) {
      const step = await sqlGeneratorAgent.run();
      const hasFunctionCall = step.rawResponse.output.some(item => item.type === "function_call");
      if (!hasFunctionCall) {
        console.log("\n===Generated Query===");
        const query = step.output;
        console.log(query + "\n");
        await executeSql(query); // Pass to executor
        break;
      } else {
        step.rawResponse.output.forEach(item => {
          if (item.type === "function_call") {
            console.log(`Tool Executed:`, item.name);
          }
        });
      }
    }
  }

  async function executeSql(query) {
    console.log("--------------------------------");
    console.log("===RUNNING EXECUTOR AGENT===\n");
    sqlExecutorAgent.addInput({
      role: "user",
      content: `Validate and then execute this SQL query: ${query}`
    });

    for (let i = 0; i < 12; i++) {
      const step = await sqlExecutorAgent.run();
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
