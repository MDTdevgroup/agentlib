import { Agent } from "../Agent.js";
import { initDB, makeSQLTools } from "./sqlTools.js";

async function main() {
  const db = await initDB("./Chinook.db");
  const tools = makeSQLTools(db);

  const agent = new Agent("gpt-4o-mini", tools);

  agent.addInput("system", "You are a helpful SQL assistant. Only use SELECT queries. Start by listing tables.");
  agent.addInput("user", "Which genre on average has the longest tracks?");

  let step;
  for (let i = 0; i < 5; i++) {  
    step = await agent.run();
    console.log("Step result:", step);

    if (step.type === "response") {
      console.log("Final Answer:", step.content);
      break;
    }
  }
}

main();
