import { config } from 'dotenv';
import { memoryObserver } from '../memory/memoryObserver.js';
import { PREFERENCE_EXTRACTION_PROMPT } from './promptTemplates.js';
import LLMService from '../services/llmService.js';

config();

/**
 * Extract wine preferences from chat and store them as memories
 * @param {String} userId - User ID
 * @param {String} userMessage - User message
 * @param {String} aiResponse - AI response
 */
export async function extractPreferencesFromChat(userId, userMessage, aiResponse) {
  try {
    // Skip extraction for very short messages
    if (userMessage.length < 5) return [];
    
    const prompt = PREFERENCE_EXTRACTION_PROMPT
      .replace('{{USER_MESSAGE}}', userMessage)
      .replace('{{AI_RESPONSE}}', aiResponse);

    const input = [{role: 'user', content: prompt}];
    
    const openAI = new LLMService('openai');
    const response = await openAI.chat(input, 'json_object');
    
    // Parse the extracted preferences
    try {
      const responseObj = JSON.parse(response);
      const extractedData = JSON.parse(responseObj.output_text);
      const preferences = extractedData.preferences || [];
      
      // Store preferences that meet confidence threshold
      const validPreferences = preferences.filter(pref => pref.confidence >= 0.6);
      
      for (const preference of validPreferences) {
        await storePreferenceAsMemory(userId, preference);
      }
      
      return validPreferences;
    } catch (parseError) {
      console.error('Error parsing preferences JSON:', parseError);
      return [];
    }
  } catch (error) {
    console.error('Error extracting preferences:', error);
    return [];
  }
}

/**
 * Store a preference as a memory
 * @param {String} userId - User ID
 * @param {Object} preference - Extracted preference
 */
async function storePreferenceAsMemory(userId, preference) {
  // Convert preference type to memory system format
  const memoryType = preference.type === 'like' ? 'like' : 
                    preference.type === 'dislike' ? 'dislike' : 'note';
  
  const memoryData = {
    userId,
    type: memoryType,
    content: `${preference.type} ${preference.subject}`,
    details: preference.details || '',
    importance: preference.confidence || 0.5,
    source: 'chat',
    createdAt: new Date(),
    time: Date.now()
  };
  
  // Add wine-specific fields if applicable
  if (isWineName(preference.subject)) {
    memoryData.wineName = preference.subject;
  } else if (isWineCategory(preference.subject)) {
    memoryData.wineType = preference.subject;
  }
  
  // Store memory using your existing memory system
  return memoryObserver.addMemory(memoryData);
}

/**
 * Check if a string is likely a wine name
 * @param {String} text - Text to check
 * @returns {Boolean} - Whether it's likely a wine name
 */
function isWineName(text) {
  if (!text) return false;
  
  // Check for common wine name patterns
  const wineVarietals = [
    'cabernet', 'merlot', 'pinot', 'sauvignon', 'chardonnay', 'riesling',
    'zinfandel', 'syrah', 'malbec', 'tempranillo', 'grenache', 'chianti'
  ];
  
  const textLower = text.toLowerCase();
  return wineVarietals.some(variety => textLower.includes(variety));
}

/**
 * Check if a string is a wine category
 * @param {String} text - Text to check
 * @returns {Boolean} - Whether it's a wine category
 */
function isWineCategory(text) {
  if (!text) return false;
  
  const wineCategories = [
    'red wine', 'white wine', 'rosé', 'sparkling wine', 'dessert wine',
    'red', 'white', 'rose', 'sparkling', 'dessert', 'sweet', 'dry',
    'full-bodied', 'light-bodied'
  ];
  
  const textLower = text.toLowerCase();
  return wineCategories.some(category => textLower.includes(category));
}