import { runCalculatorExample, runConcurrentCalculators } from './index.js';

async function main() {
  try {
    console.log("Calculator Agent Test Script");
    console.log("===============================\n");
    
    await runCalculatorExample();
    
    console.log("\n" + "=".repeat(60) + "\n");
    
    await runConcurrentCalculators();
    
  } catch (error) {
    console.error("Error running calculator examples:", error);
  }
}

// Run the main function
main(); 