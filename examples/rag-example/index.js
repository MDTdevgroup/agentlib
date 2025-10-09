import { MongoClient } from 'mongodb';
import { MONGODB_URI, DATABASE_NAME, COLLECTION_NAME, EMBEDDING_MODEL, NUM_CANDIDATES, LIMIT } from './config.js';
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
            const results = await queryResults(args.query);
            console.log(`\nResults: ${results}\n`);
            return results;
        }
    }
];

async function queryResults(userQuery) {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = await client.db(DATABASE_NAME);
    const collection = db.collection(COLLECTION_NAME);
    console.log("connection to database successful");
  
    // Step 1: Embed the user query
    const queryEmbedding = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: userQuery
    });
  
    const queryVector = queryEmbedding.data[0].embedding;
  
    // Step 2: Use Atlas Vector Search to find most similar chunks
    const pipeline = [
        {
            $vectorSearch: {
                index: "vector_index",   // Name of the MongoDB Vector Search index to use.
                path: "chunks.embedding",   // Path to the vector field in the collection.          
                queryVector: queryVector,   // The vector to search for.
                numCandidates: NUM_CANDIDATES,  // This controls how many vectors MongoDB initially considers before returning the top results.          
                limit: LIMIT // This returns the top n results from the set of candidates chosen.                   
            }
        },
        {
            // 1. Project the required fields and capture the vector search score (only 1 score per document, for the best-matched chunk)
            $project: {
                title: 1,
                chunks: 1,
                score: { $meta: "vectorSearchScore" }
            }
        },
        {
            // 2. Break down the document into individual results, one for each chunk
            $unwind: "$chunks" 
        },
        {
            // 3. Project the final, clean fields for RAG context
            $project: {
                _id: 0,
                title: "$title",
                text: "$chunks.text",
                score: "$score"
            }
        },
        {
            // 4. Limit the final results to the top N chunks overall (e.g., top 3 chunks)
            $limit: 3
        }
    ];

    const results = await collection.aggregate(pipeline).toArray();

    // Step 3: Format results into a single string for the RAG agent
    console.log("Top results:");
    const context = results.map(r => {
        console.log(`\n[${r.title}] (score: ${r.score.toFixed(3)})`);
        console.log(r.text);
        return `Document: ${r.title}\nChunk: ${r.text}`;
    }).join('\n---\n');

    await client.close();
    return context; // Return the formatted context string
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
