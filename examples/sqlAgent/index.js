import './instrumentation.js';
import { Agent } from "../../src/Agent.js";
import { LLMService } from "../../src/llmService.js";
import { ToolLoader } from "../../src/ToolLoader.js";
import { PromptLoader } from "../../src/prompt-loader/promptLoader.js";
import { initDB, generatorTools, executorTools, mainAgentTools, getSalesForArtist, getTopTracksInGenre } from "./sqlTools.js";
import readline from "readline";
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import EventEmitter from 'events';
import { DomainObservability } from "../../src/utilities/observability.js";

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
  const promptsPath = './prompts.yml';

  const genTools = new ToolLoader();
  genTools.addTools(generatorTools(db));
  const execTools = new ToolLoader();
  execTools.addTools(executorTools(db));
  const mainTools = new ToolLoader();
  mainTools.addTools(mainAgentTools(db));

  const promptLoader = await PromptLoader.create(promptsPath);
  const sharedBus = new EventEmitter();

  // Enable both file and OpenTelemetry output
  new DomainObservability(sharedBus, { mode: 'file' });

  const sqlGeneratorAgent = new Agent(llmService, {
    toolLoader: genTools, eventEmitter: sharedBus
  });

  sqlGeneratorAgent.addInput({
    role: "system",
    content: promptLoader.getPrompt("sql_generator_sys_prompt").format()
  });

  const sqlExecutorAgent = new Agent(llmService, {
    toolLoader: execTools,
    outputSchema: executorOutputSchema,
    eventEmitter: sharedBus
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
    eventEmitter: sharedBus
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

      mainAgent.addInput({ role: "user", content: answer });

      const response = await mainAgent.run();

      if (!response.executed) {
        ask();
        return;
      }

      for (const item of response.executed) {
        const functionName = item.name;
        if (functionName === "generate_custom_sql_query") {
          await runSqlGenerator(answer);
        }
      }

      // loop back
      ask();
    });
  }

  async function runSqlGenerator(queryPrompt) {
    sqlGeneratorAgent.addInput({ role: "user", content: queryPrompt });

    // Run generator agent
    for (let i = 0; i < 10; i++) {
      const step = await sqlGeneratorAgent.run();
      const hasFunctionCall = step.rawResponse.output.some(item => item.type === "function_call");
      if (!hasFunctionCall) {
        const query = step.output;
        await executeSql(query); // Pass to executor
        break;
      }
    }
  }

  async function executeSql(query) {
    sqlExecutorAgent.addInput({
      role: "user",
      content: `Validate and then execute this SQL query: ${query}`
    });

    for (let i = 0; i < 12; i++) {
      const step = await sqlExecutorAgent.run();
      const hasFunctionCall = step.rawResponse.output.some(item => item.type === "function_call");
      if (!hasFunctionCall) {
        // No more function calls, process the structured output
        try {
          const parsedOutput = step.output;
          console.log(parsedOutput.explanation_summary);
        } catch (error) {
        }
        break;
      }
    }
  }

  ask();
}

main();
