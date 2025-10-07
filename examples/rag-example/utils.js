// This script is intended to be run only once to generate embeddings for all documents
// and store them in MongoDB for later use in a RAG pipeline.

import dotenv from "dotenv";
import OpenAI from "openai";
import { MongoClient } from "mongodb";
import { MONGODB_URI, DATABASE_NAME, COLLECTION_NAME, docs } from './config.js';

dotenv.config({ path: "../../.env" });

const client = new MongoClient(MONGODB_URI);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function initDatabase() {
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const collection = db.collection(COLLECTION_NAME);

    function chunkText(text, size = 150) {
      const chunks = [];
      for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
      }
      return chunks;
    }

    for (const doc of docs) {
      const chunks = chunkText(doc.content);
      const embeddings = [];

      for (const chunk of chunks) {
        const response = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunk
        });
        embeddings.push({
          text: chunk,
          embedding: response.data[0].embedding
        });
      }

      await collection.insertOne({
        ...doc,
        chunks: embeddings
      });

      console.log(`Inserted and embedded: ${doc.title}`);
    }

    console.log("All documents inserted with embeddings.");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await client.close();
  }
}

initDatabase();