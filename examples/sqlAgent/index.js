import { Agent } from "../../src/Agent.js";
import { LLMService } from "../../src/LLMService.js";
import { ToolLoader } from "../../src/ToolLoader.js";
import { PromptLoader } from "../../src/prompt-loader/promptLoader.js";
import { initDB, generatorTools, executorTools, mainAgentTools, getSalesForArtist, getTopTracksInGenre } from "./sqlTools.js";
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
  console.log("Agent: What would you like to do? (type 'quit' to exit)");
  const db = await initDB("./chinook.db");
  const promptsPath = './prompts.yml';

  const llmService = new LLMService('openai', process.env.OPENAI_API_KEY);

  const genTools = new ToolLoader();
  genTools.addTools(generatorTools(db));
  const execTools = new ToolLoader();
  execTools.addTools(executorTools(db));
  const mainTools = new ToolLoader();
  mainTools.addTools(mainAgentTools(db));

  const promptLoader = await PromptLoader.create(promptsPath);

  const sqlGeneratorAgent = new Agent(llmService, { 
    toolLoader: genTools 
  });

  sqlGeneratorAgent.addInput({
    role: "system",
    content: promptLoader.getPrompt("sql_generator_sys_prompt").format()
  });

  const sqlExecutorAgent = new Agent(llmService, {
    toolLoader: execTools,
    outputSchema: executorOutputSchema
  });

  sqlExecutorAgent.addInput({
    role: "system",
    content: promptLoader.getPrompt("sql_executor_sys_prompt").format()
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const mainAgent = new Agent(llmService, {
    toolLoader: mainTools,
  });

  mainAgent.addInput({
    role: "system",
    content: promptLoader.getPrompt("main_agent_sys_prompt").format()
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
