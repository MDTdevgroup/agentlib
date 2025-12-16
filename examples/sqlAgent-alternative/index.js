import { Agent } from "../../src/Agent.js";
import { LLMService } from "../../src/LLMService.js";
import { ToolLoader } from "../../src/ToolLoader.js";
import { PromptLoader } from "../../src/prompt-loader/promptLoader.js";
import { initDB, mainAgentTools } from "./sqlTools.js";
import readline from "readline";
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

async function main() {
    console.log("==================================================");
    console.log("  SQL Agent (Alternative Architecture) Initialized");
    console.log("==================================================");

    try {
        const db = await initDB("./chinook.db");
        const promptsPath = './prompts.yml';
        const promptLoader = await PromptLoader.create(promptsPath);
        const llmService = new LLMService('openai', process.env.OPENAI_API_KEY);

        // Initialize Main Agent definition
        const mainToolsLoader = new ToolLoader();
        mainToolsLoader.addTools(mainAgentTools(db, llmService, promptLoader));

        const mainAgent = new Agent(llmService, {
            toolLoader: mainToolsLoader,
        });

        mainAgent.addInput({
            role: "system",
            content: promptLoader.getPrompt("main_agent_sys_prompt").format()
        });

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const ask = () => {
            rl.question("\nUser: ", async (answer) => {
                if (answer.toLowerCase() === "quit" || answer.toLowerCase() === "exit") {
                    console.log("\n[System] Exiting...");
                    rl.close();
                    process.exit(0);
                }

                mainAgent.addInput({ role: "user", content: answer });

                console.log("\n[MainAgent] Processing...");

                let completion = false;
                for (let i = 0; i < 15; i++) {
                    const step = await mainAgent.run();

                    // Log executed tools
                    if (step.executed && step.executed.length > 0) {
                        step.executed.forEach(tool => {
                            console.log(`[MainAgent] Call: ${tool.name}`);
                        });
                    }

                    // Check for final textual response
                    // We check if the agent produced output AND is not requesting another tool execution immediately
                    const hasPendingToolCalls = step.rawResponse.output.some(item => item.type === "function_call");
                    if (step.output && !hasPendingToolCalls) {
                        console.log("\n=== Final Response ===");
                        console.log(step.output);
                        console.log("======================\n");
                        completion = true;
                        break;
                    }
                }

                if (!completion) {
                    console.warn("[MainAgent] Warning: Max iterations reached without final response.");
                }

                ask(); // Continue loop
            });
        };

        ask();

    } catch (error) {
        console.error("[System] Error initializing agent:", error);
        process.exit(1);
    }
}

main();
