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
        name: "retriever",
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

    const pipeline = [
        {
           $scoreFusion: {
              input: {
                 pipelines: {
                    searchOne: [
                       {
                          "$vectorSearch": {
                             "index": "hybrid-vector-search",
                             "path": "chunks.embedding",
                             "queryVector": queryVector,
                             "numCandidates": NUM_CANDIDATES,
                             "limit": LIMIT
                          }
                       }
                    ],
                    searchTwo: [
                       {
                          "$search": {
                             "index": "hybrid-full-text-search",
                             "text": {
                                "query": userQuery,   
                                "path": ["title", "content"]
                             }
                          }
                       },
                    ]
                 },
                 normalization: "sigmoid"
              },
              combination: {
                 method: "expression",
                 expression: {
                    $sum: [
                      {$multiply: [ "$$searchOne", 10]}, "$$searchTwo"
                    ]
                 }
              },
              "scoreDetails": true
           }
        },
        {
           "$project": {
              _id: 1,
              title: 1,
              content: 1,
              chunks: 1,
              scoreDetails: {"$meta": "scoreDetails"}
           }
        },
        { $limit: 10 }
     ]

    const results = await collection.aggregate(pipeline).toArray();

    // Step 3: Format results into a single string for the RAG agent
    console.log("Top results:");
    const context = results.map(r => {
        console.log(`\n[${r.title}]`);
        console.log(r.content);  
        return `Document: ${r.title}\nContent: ${r.content}`;
    }).join('\n---\n');

    await client.close();
    return context; // Return the formatted context string
}

async function runRAGExample() {
    const agent = new Agent('openai', process.env.OPENAI_API_KEY, {
        model: "gpt-4o-mini",
        tools: tools
    });

    agent.addInput({
        role: "system", 
        content: "You are a helpful assistant that can answer questions about the documents in the database. The user will ask you a question and you will generate a query and use the retriever tool to retrieve the most relevant documents from the database."
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
            console.log("Agent:", response.output);
        }
    } finally {
        rl.close();
    }
}
runRAGExample().catch(console.dir);
