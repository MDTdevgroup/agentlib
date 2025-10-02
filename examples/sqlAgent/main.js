import { Agent } from "../../src/Agent.js";
import { initDB, generatorTools, executorTools } from "./sqlTools.js";

async function main() {
  const db = await initDB("./chinook.db");
  const genTools = generatorTools(db);
  const execTools = executorTools(db);
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type='table';"
  );
  console.log("### Tables:", tables.map(t => t.name));

  const generatorAgent = new Agent({tools: genTools});
  generatorAgent.addInput({role: "system", content: 
    `You are a helpful SQL generator.
     - Only propose a single SELECT query as your final answer.
     - Use the provided tools (list_tables, get_schema) to explore the schema as needed.
     - Do NOT execute queries.
     - When you are done, reply with ONLY the SQL query, no explanations.`
  });
  generatorAgent.addInput({role: "user", content: "Which genre on average has the longest tracks?"});

  const executorAgent = new Agent({tools: execTools});
  const systemPrompt = `You are a SQL expert with a strong attention to detail.
    Double check the SQL query for common mistakes, including:
    - Using NOT IN with NULL values
    - Using UNION when UNION ALL should have been used
    - Using BETWEEN for exclusive ranges
    - Data type mismatch in predicates
    - Properly quoting identifiers
    - Using the correct number of arguments for functions
    - Casting to the correct data type
    - Using the proper columns for joins
    - Ensuring the query is read-only (SELECT-only);

    If there are any of the above mistakes, rewrite the query. If there are no mistakes,
    just reproduce the original query.

    You may use schema tools (list_tables, get_schema) to validate if needed.
    When ready, call the run_query tool to execute the final validated query.`;
  executorAgent.addInput({role: "system", content: systemPrompt});

  let step;
  
  // First, let the generator agent explore and generate a query
  console.log("=== GENERATOR AGENT ===");
  for (let i = 0; i < 10; i++) {  
    step = await generatorAgent.run();
    console.log("### Generator Step:", step);
    step.output.forEach(item => {
      console.log(`Output Type:`, item.type);
    });
    const hasFunctionCall = step.output.some(item => item.type === "function_call");
    if (!hasFunctionCall) {
      console.log("Generated Query:", step.output_text);
      await validateAndExecute(step.output_text);
      break;
    }
  }

  async function validateAndExecute(query) { 
    console.log("Validating and executing query:", query);
    console.log("\n=== EXECUTOR AGENT ===");
    executorAgent.addInput({role: "user", content: `Validate and then execute this SQL query: ${query}`});
    
    for (let i = 0; i < 12; i++) {
      step = await executorAgent.run();
      console.log("### Executor Step:", step);
      step.output.forEach(item => {
        console.log(`Output Type:`, item.type);
      });
      
      const hasFunctionCall = step.output.some(item => item.type === "function_call");
      if (!hasFunctionCall) {
        console.log("Final Answer:", step.output_text || step.output.map(o => o.content).join("\n"));
        break;
      }
    }
  }
}

main();
