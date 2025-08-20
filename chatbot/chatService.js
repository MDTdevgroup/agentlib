import { config } from 'dotenv';
import axios from "axios";
import { getMemoriesByRelevance } from '../memory/memorySystem.js';
import { formatConversation } from './messageFormatters.js';
import { 
  searchNearbyRestaurants, 
  getLocationBasedRecommendations,
  textSearchPlaces
} from '../services/locationService.js';
import { run } from '../services/recommendationService.js';
import { extractWinesFromVenue } from '../services/wineExtractionService.js';
import { Agent } from '../services/Agent.js';
import { chatBotSystemPrompt } from '../prompts/llmPrompts.js';
import taskManager from '../services/taskManager.js';

config();

const KEY = process.env.GOOGLE_MAPS_API_KEY;

// --- Tool Definitions for Agent ---

// Create chatbot tools for the agent
function createChatbotTools() {
    const toolFunctions = {
        navigate_to_camera: async (args) => {
            try {
                return { 
                    success: true, 
                    action: "navigate_to_camera",
                    message: "Navigating to camera screen for wine label scanning."
                };
            } catch (e) {
                return { success: false, message: "Failed to navigate to camera." };
            }
        },
        navigate_to_locations: async (args) => {
            try {
                return { 
                    success: true, 
                    action: "navigate_to_locations",
                    message: "Navigating to locations screen to find nearby wine venues."
                };
            } catch (e) {
                return { success: false, message: "Failed to navigate to locations." };
            }
        },
        get_nearby_wine_recommendations: async (args) => {
            try {
                // Add task for immediate parallel execution
                const taskId = taskManager.addTask(
                    'get_nearby_recommendations', 
                    args,
                    async (taskArgs) => {
                        // This would need user location - placeholder implementation
                        return {
                            success: true,
                            message: "Nearby recommendations would be based on your location.",
                            restaurants: []
                        };
                    }
                );
                
                return { 
                    success: true, 
                    action: "get_nearby_recommendations",
                    taskId: taskId,
                    message: "🗺️ Finding nearby restaurants with great wine selections. I'll search the area and get back to you!"
                };
            } catch (e) {
                return { success: false, message: "Failed to start nearby recommendations task." };
            }
        },
        search_and_recommend: async (args) => {
            try {
                // Add task for immediate parallel execution
                const taskId = taskManager.addTask(
                    'search_and_recommend', 
                    args,
                    async (taskArgs) => await searchAndRecommend(taskArgs.query, taskArgs.preferences)
                );
                
                return { 
                    success: true, 
                    action: "search_and_recommend",
                    taskId: taskId,
                    message: `Searching for "${args.query}" and finding wine recommendations. I'll have results for you shortly! You can continue chatting while I work.`
                };
            } catch (e) {
                return { success: false, message: "Failed to start search and recommendation task." };
            }
        },
        navigate_to_home: async (args) => {
            try {
                return { 
                    success: true, 
                    action: "navigate_to_home",
                    message: "Navigating back to home screen."
                };
            } catch (e) {
                return { success: false, message: "Failed to navigate to home." };
            }
        }
    };

    return [
        {
            type: "function",
            name: "navigate_to_camera",
            description: "Navigate to the camera screen to scan a wine label or take a photo",
            parameters: {
                type: "object",
                properties: {},
                required: []
            },
            func: toolFunctions.navigate_to_camera
        },
        {
            type: "function",
            name: "navigate_to_locations",
            description: "Navigate to the locations screen to find nearby wine venues",
            parameters: {
                type: "object",
                properties: {},
                required: []
            },
            func: toolFunctions.navigate_to_locations
        },
        {
            type: "function",
            name: "get_nearby_wine_recommendations",
            description: "Get wine recommendations from the closest restaurant",
            parameters: {
                type: "object",
                properties: {
                    preferences: {
                        type: "string",
                        description: "Any specific wine preferences mentioned"
                    }
                },
                required: []
            },
            func: toolFunctions.get_nearby_wine_recommendations
        },
        {
            type: "function",
            name: "search_and_recommend",
            description: "Search for a specific restaurant and get wine recommendations",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The name or description of the restaurant to search for"
                    },
                    preferences: {
                        type: "string",
                        description: "Any specific wine preferences mentioned"
                    }
                },
                required: ["query"]
            },
            func: toolFunctions.search_and_recommend
        },
        {
            type: "function",
            name: "navigate_to_home",
            description: "Navigate back to the home screen",
            parameters: {
                type: "object",
                properties: {},
                required: []
            },
            func: toolFunctions.navigate_to_home
        }
    ];
}

/**
 * Process a user message and return appropriate response
 * @param {String} userId - User ID
 * @param {String} message - User message
 * @param {Array} conversationHistory - Previous conversation messages
 * @returns {Object} Response object with message and metadata
 */
export async function processUserMessage(userId, message, conversationHistory = []) {
  try {
    // 1. Retrieve relevant memories based on the user's message
    const relevantMemories = await getMemoriesByRelevance(message, 5);
    
    // 2. Format conversation history for the API
    const formattedConversation = formatConversation(conversationHistory);
    
    // 3. Format memories for the prompt
    const memoryContext = relevantMemories.length > 0 
      ? "User preferences: " + relevantMemories.map(m => m.content).join("; ")
      : "No specific preferences known yet.";
    
    // 4. Get relevant wine knowledge
    const wineKnowledge = await getWineKnowledge(message);
    
    // 5. Create Agent with chatbot tools
    const tools = createChatbotTools();
    const agent = new Agent('gpt-4o-mini', tools);
    
    // 6. Construct the system message
    const systemMessage = chatBotSystemPrompt(memoryContext, wineKnowledge);
    
    agent.addInput("system", systemMessage);
    
    // 7. Add conversation history
    formattedConversation.forEach(msg => {
      // Skip messages with null/undefined content
      if (msg.content && typeof msg.content === 'string') {
        agent.addInput(msg.role, msg.content);
      }
    });
    
    // 8. Add current user message
    agent.addInput("user", message);
    
    // 9. Run the agent
    const response = await agent.run();
    
    // 10. Handle response
    if (response.type === "function_call") {
      const toolResult = response.result;
      
      // Extract and store any new memories from this interaction
      await extractAndStoreMemories(userId, message, toolResult.message);
      
      return {
        message: toolResult.message,
        toolCall: {
          name: response.tool,
          arguments: response.args,
          result: toolResult
        },
        referencedMemories: relevantMemories.map(m => m._id),
        usedWineKnowledge: !!wineKnowledge
      };
          } else {
        // Handle regular text response
        let aiResponse = "";
        if (response.type === "response" && response.content) {
          // Handle response content from Agent
          if (typeof response.content === 'string') {
            aiResponse = response.content;
          } else {
            // If content is an object, try to extract text from it
            try {
              const parsed = JSON.parse(JSON.stringify(response.content));
              aiResponse = parsed.output_text || JSON.stringify(response.content);
            } catch (e) {
              aiResponse = JSON.stringify(response.content);
            }
          }
        } else if (response.type === "text") {
          aiResponse = response.content;
        } else {
          aiResponse = "I can help you with wine recommendations and navigation.";
        }
        
        // Extract and store any new memories from this interaction
        await extractAndStoreMemories(userId, message, aiResponse);
        
        return {
          message: aiResponse,
          referencedMemories: relevantMemories.map(m => m._id),
          usedWineKnowledge: !!wineKnowledge
        };
      }
  } catch (error) {
    console.error('Error in chat service:', error);
    return {
      message: "I'm sorry, I encountered an error while processing your message. Please try again.",
      error: error.message
    };
  }
}

export async function searchAndRecommend(query, preferences = "") {
    try {
        const places = await textSearchPlaces(query);
        if (places.length === 0) {
            return { success: false, message: `Could not find any restaurant matching "${query}".` };
        }

        const topPlace = places[0];
        const wineExtractionResult = await extractWinesFromVenue(topPlace, preferences, false);

        if (!wineExtractionResult.success || wineExtractionResult.wines.length === 0) {
            return {
                success: false,
            };
        }

        const recommendation = await run(null, preferences, wineExtractionResult.wines);
        
        return {
            success: true,
            restaurant: {
                name: topPlace.name,
                address: topPlace.vicinity || topPlace.formatted_address,
                id: topPlace.place_id,
            },
            result: recommendation,
            message: `Generated recommendation based on ${wineExtractionResult.wines.length} wines from ${topPlace.name}.`
        };
    } catch (error) {
        console.error('Error in searchAndRecommend:', error);
        return { success: false, message: "Failed to get recommendations. " + error.message };
    }
}

/**
 * Implement handler for nearby wine recommendations
 * @param {Object} location - User's location {latitude, longitude}
 * @param {String} preferences - User's wine preferences
 * @returns {Object} Recommendations and metadata
 */
export async function getNearbyWineRecommendations(location, preferences = "") {
  try {
    // This function calls the locationRestaurantHandler functionality directly
    const recommendations = await getLocationBasedRecommendations(location, preferences);
    return recommendations;
  } catch (error) {
    console.error('Error getting nearby wine recommendations:', error);
    return {
      success: false,
      message: "Failed to get nearby wine recommendations. " + error.message
    };
  }
}

/**
 * Get recommendations for a specific restaurant
 * @param {String} restaurantId - Google Place ID of the restaurant
 * @param {String} preferences - User's wine preferences
 * @returns {Object} Recommendations and metadata
 */
export async function getRestaurantWineRecommendations(restaurantId, preferences = "") {
  try {
    const wineExtractionResult = await extractWinesFromVenue({ place_id: restaurantId }, preferences, false);

    if (!wineExtractionResult.success || wineExtractionResult.wines.length === 0) {
        return {
            success: false,
            message: wineExtractionResult.message || `No wine menu could be extracted for the requested restaurant.`
        };
    }
    
    const place = wineExtractionResult.placeDetails;
    const recommendation = await run(null, preferences, wineExtractionResult.wines);
    
    return {
      success: true,
      restaurant: {
        name: place.name,
        address: place.vicinity || place.formatted_address,
        id: restaurantId
      },
      result: recommendation,
      message: `Generated recommendation based on ${wineExtractionResult.wines.length} wines from ${place.name}.`
    };
  } catch (error) {
    console.error('Error getting restaurant wine recommendations:', error);
    return {
      success: false,
      message: "Failed to get restaurant wine recommendations. " + error.message
    };
  }
}

// Helper function to get wine knowledge (imported from your existing code)
async function getWineKnowledge(message) {
  try {
    // Import dynamically to avoid circular dependencies
    const { getWineKnowledge } = await import('./wineKnowledgeBase.js');
    return await getWineKnowledge(message);
  } catch (error) {
    console.error("Error getting wine knowledge:", error);
    return "";
  }
}

/**
 * Extract potential preference information from conversation and store as memories
 */
async function extractAndStoreMemories(userId, userMessage, aiResponse) {
  try {
    // Import the function here to avoid circular dependencies
    const { extractPreferencesFromChat } = await import('./extractMemoriesFromChat.js');
    
    // Extract and store preferences
    return await extractPreferencesFromChat(userId, userMessage, aiResponse);
  } catch (error) {
    console.error("Error extracting memories:", error);
    return null;
  }
}