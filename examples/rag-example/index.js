import { MongoClient } from 'mongodb';
import { MONGODB_URI, DATABASE_NAME, COLLECTION_NAME, EMBEDDING_MODEL } from './config.js';
import { Agent } from '../../src/Agent.js';
import readline from "readline";
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools = [
    {
        type: "function",
        name: "retreiver",
        description: "Use query to retrieve the most relevant documents from the database",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The query to retrieve the most relevant documents from the database" }
            },
            required: ["query"]
        },
        func: async (args) => {
            console.log(`Retrieving documents for query: ${args.query}`);
            const results = await semanticSearch(args.query);
            console.log(`\nResults: ${results}\n`);
            return results;
        }
    }
];

function cosineSimilarity(a, b) {
    let dot = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function semanticSearch(userQuery) {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = await client.db(DATABASE_NAME);
    const collection = db.collection(COLLECTION_NAME);
  
    // Step 1: Embed the user query
    const queryEmbedding = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: userQuery
    });
  
    const queryVector = queryEmbedding.data[0].embedding;
  
    // Step 2: Fetch all chunks and compute cosine similarity manually
    const docs = await collection.find().toArray();
  
    let results = [];
  
    for (const doc of docs) {
      for (const chunk of doc.chunks) {
        const similarity = cosineSimilarity(queryVector, chunk.embedding);
        results.push({
          title: doc.title,
          text: chunk.text,
          similarity
        });
      }
    }
  
    // Step 3: Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);
  
    // Step 4: Return the top 3 most relevant chunks
    console.log("Top results:");
    for (const r of results.slice(0, 3)) {
      console.log(`\n[${r.title}] (${r.similarity.toFixed(3)})\n${r.text}`);
    }
  
    return results;
}

async function runRAGExample() {
    const agent = new Agent({
        model: "gpt-4o-mini",
        tools: tools
    });

    agent.addInput({
        role: "system", 
        content: "You are a helpful assistant that can answer questions about the documents in the database. The user will ask you a question and you will generate a query and use the retreiver tool to retrieve the most relevant documents from the database."
    });

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {    
        while (true) {
            const userInput = await new Promise(resolve => {
                rl.question("User: ", answer => resolve(answer));
              });              
            agent.addInput({ role: "user", content: userInput });
            const response = await agent.run();
            console.log("Agent:", response.output_text);
        }
    } finally {
        rl.close();
    }
}
runRAGExample().catch(console.dir);
