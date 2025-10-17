import { MONGODB_URI } from './config.js'; 
import { MongoClient } from "mongodb";

// connect to Atlas deployment

const client = new MongoClient(MONGODB_URI);

async function run() {
  try {
    const database = client.db("agentlib");
    const collection = database.collection("documents");

    
    // define MongoDB Hybrid Search index
    const vectorSearchIndex = {
      name: "hybrid_vector_index",
      type: "vectorSearch",
      definition: {
        "fields": [
          {
            "type": "vector",
            "numDimensions": 1536,
            "path": "chunks.embedding",
            "similarity": "dotProduct",
            "quantization": "scalar"
          }
        ]
      }
    }

    const searchIndex = {
      name: "hybrid-full-text-search",
      type: "search",
      definition: {
        "mappings": {
          "dynamic": true
        }
      }
    }

     // run the helper method
     const result = await collection.createSearchIndex(vectorSearchIndex);
     console.log(`New search index named ${result} is building.`);

     const result2 = await collection.createSearchIndex(searchIndex);
     console.log(`New search index named ${result2} is building.`);

     // wait for the index to be ready to query
     console.log("Polling to check if the index is ready. This may take up to a minute.")
     let isQueryable = false;
     while (!isQueryable) {
       const cursor = collection.listSearchIndexes();
       for await (const index of cursor) {
         if (index.name === result) {
           if (index.queryable) {
             console.log(`${result} is ready for querying.`);
             isQueryable = true;
           } else {
             await new Promise(resolve => setTimeout(resolve, 5000));
           }
         }
       }
     }
   } finally {
     await client.close();
   }
}
run().catch(console.dir);
