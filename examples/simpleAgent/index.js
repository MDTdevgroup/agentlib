import { Agent } from '../../src/Agent.js';
import { chromium } from "playwright";
import readline from "readline";
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

const tools = [
    {
      type: 'function',
      name: 'web_search',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      },
      func: async (args) => {
        const browser = await chromium.launch({ headless: false });
        const page = await browser.newPage();
        await page.goto("https://yandex.com");
        
        // Wait for the search box to be ready and fill it
        await page.waitForSelector('input[name="text"]');
        await page.fill('input[name="text"]', args.query);
        await page.keyboard.press("Enter");
        
        // Wait for results to load
        await page.waitForSelector(".OrganicTitle-Link", { timeout: 10000 });
  
        const results = await page.$$eval(".OrganicTitle-Link", nodes => 
          nodes.slice(0, 5).map(n => n.innerText)
        );
        await browser.close();
        return { query: args.query, results };
      }
    },
    {
      type: 'function',
      name: 'quit',
      description: 'Quit the agent',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      func: async (args) => { console.log(`Quitting: ${args.reason}`); process.exit(0); }
    }
  ];

const agent = new Agent('openai', process.env.OPENAI_API_KEY, {tools: tools});

while (true) {
    const userInput = await ask("Agent: What would you like to do?\n");
    agent.addInput({ role: 'user', content: userInput });
    const response = await agent.run();
  
    // If a tool was called, print the tool result
    if (response.type === "function_call") {
      console.log("Tool result:", response.result);
    } else {
      console.log("Agent:", response.output_text);
    }
  }