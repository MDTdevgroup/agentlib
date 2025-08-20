import { MongoClient, ObjectId } from 'mongodb';
import { config } from 'dotenv';

config();

const MONGO_URI = 'mongodb://localhost:27017';
const DB_NAME = 'Vino';
const CONVERSATIONS_COLLECTION = 'conversations';
const MAX_CONVERSATION_LENGTH = 20; // Maximum number of messages to keep

/**
 * Retrieve conversation history for a user
 */
export async function getConversationHistory(userId, limit = MAX_CONVERSATION_LENGTH) {
  try {
    const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });
    await client.connect();
    
    const collection = client.db(DB_NAME).collection(CONVERSATIONS_COLLECTION);
    
    // Find conversation for the user, sorted by timestamp
    const conversation = await collection
      .find({ userId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    
    await client.close();
    
    // Return in chronological order
    return conversation.reverse();
  } catch (error) {
    console.error('Error retrieving conversation history:', error);
    return [];
  }
}

/**
 * Add a message to the conversation history
 */
export async function addMessageToHistory(userId, message, role = 'user', metadata = {}) {
  try {
    const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });
    await client.connect();
    
    const collection = client.db(DB_NAME).collection(CONVERSATIONS_COLLECTION);
    
    const messageDoc = {
      _id: new ObjectId(),
      userId,
      content: message,
      role,
      timestamp: new Date(),
      ...metadata,
    };
    
    await collection.insertOne(messageDoc);
    
    // Optional: Clean up old messages if needed
    const count = await collection.countDocuments({ userId });
    if (count > MAX_CONVERSATION_LENGTH * 2) {
      const oldestMessages = await collection
        .find({ userId })
        .sort({ timestamp: 1 })
        .limit(count - MAX_CONVERSATION_LENGTH)
        .toArray();
      
      const oldestIds = oldestMessages.map(msg => msg._id);
      await collection.deleteMany({ _id: { $in: oldestIds } });
    }
    
    await client.close();
    return messageDoc;
  } catch (error) {
    console.error('Error adding message to history:', error);
    throw error;
  }
}

/**
 * Clear conversation history for a user
 */
export async function clearConversationHistory(userId) {
  try {
    const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });
    await client.connect();
    
    const collection = client.db(DB_NAME).collection(CONVERSATIONS_COLLECTION);
    await collection.deleteMany({ userId });
    
    await client.close();
    return true;
  } catch (error) {
    console.error('Error clearing conversation history:', error);
    return false;
  }
}