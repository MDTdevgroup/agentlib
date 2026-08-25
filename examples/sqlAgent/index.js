import './instrumentation.js';
import { Agent, LLMService, ToolLoader, PromptLoader } from "../../index.js";
import { initDB, generatorTools, executorTools, mainAgentTools } from "./sqlTools.js";
import readline from "readline";
import { z } from 'zod';
import EventEmitter from 'events';
import { DomainObservability } from "../../src/services/observability.js";

const llmService = new LLMService({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY });

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

      let turn = await mainAgent.start();
      while (!turn.isDone) {
        turn = await turn.next();
      }

      const response = turn;

      if (!response.executedTools || response.executedTools.length === 0) {
        ask();
        return;
      }

      for (const item of response.executedTools) {
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

    let turn = await sqlGeneratorAgent.start();
    while (!turn.isDone) {
      turn = await turn.next();
    }
    
    const query = turn.output;
    await executeSql(query);
  }

  async function executeSql(query) {
    sqlExecutorAgent.addInput({
      role: "user",
      content: `Validate and then execute this SQL query: ${query}`
    });

    let turn = await sqlExecutorAgent.start();
    while (!turn.isDone) {
      turn = await turn.next();
    }
    
    try {
      const parsedOutput = turn.rawResponse.output_parsed;
      console.log(parsedOutput.explanation_summary);
    } catch (error) {
      console.log(turn.output);
    }
  }

  ask();
}

main();
