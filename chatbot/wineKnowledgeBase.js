import { config } from 'dotenv';
import llmService from '../services/llmService.js';

config();

// Simple cache to avoid redundant knowledge retrievals
const knowledgeCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Retrieve relevant wine knowledge based on user query
 * @param {String} query - User's message
 * @returns {String} - Relevant wine knowledge snippets
 */
export async function getWineKnowledge(query) {
  try {
    // Check if we have a cached response
    const cacheKey = query.toLowerCase().trim();
    if (knowledgeCache.has(cacheKey)) {
      const { knowledge, timestamp } = knowledgeCache.get(cacheKey);
      
      // If cache is still valid, return it
      if (Date.now() - timestamp < CACHE_TTL) {
        return knowledge;
      }
    }
    
    // Determine if the query is about wine knowledge
    const isWineQuery = await isWineRelatedQuery(query);
    
    if (!isWineQuery) {
      return "";
    }
    
    // Extract key terms for knowledge retrieval
    const keyTerms = await extractWineKeyTerms(query);
    
    // Look up information based on key terms
    // For now, we'll use a simple dataset of wine facts
    const wineKnowledge = await getWineFactsForTerms(keyTerms);
    
    // Cache the knowledge
    knowledgeCache.set(cacheKey, {
      knowledge: wineKnowledge,
      timestamp: Date.now()
    });
    
    return wineKnowledge;
  } catch (error) {
    console.error('Error retrieving wine knowledge:', error);
    return "";
  }
}

/**
 * Determine if a query is wine-related
 * @param {String} query - User's message
 * @returns {Boolean} - Whether the query is wine-related
 */
async function isWineRelatedQuery(query) {
  if (!query) return false;
  
  const wineTerms = [
    "wine", "red", "white", "rosé", "rose", "vintage", "bottle", 
    "pairing", "grape", "vineyard", "sommelier", "tannin", "acidity",
    "cabernet", "merlot", "chardonnay", "sauvignon", "pinot", "noir",
    "blanc", "riesling", "zinfandel", "malbec", "syrah", "shiraz"
  ];
  
  // Simple check for wine terms
  const queryLower = query.toLowerCase();
  return wineTerms.some(term => queryLower.includes(term));
}

/**
 * Extract key wine terms from a user query
 * @param {String} query - User's message
 * @returns {Array} - Array of key wine terms
 */
async function extractWineKeyTerms(query) {
  try {
    const input = [{ role: "user", content: query }];
    
    const response = await llmService.chat(
      input,
      null,
      {
        temperature: 0.3
      }
    );
    
    const termsText = response.output_text;
    
    return termsText.split(',').map(term => term.trim()).filter(Boolean);
  } catch (error) {
    console.error('Error extracting wine terms:', error);
    return [];
  }
}

/**
 * Get wine facts based on key terms
 * @param {Array} terms - Key wine terms
 * @returns {String} - Wine knowledge text
 */
async function getWineFactsForTerms(terms) {
  if (!terms || terms.length === 0) {
    return "";
  }
  
  try {
    const input = [{ role: "user", content: `Provide concise, accurate information about these wine topics: ${terms.join(', ')}. 
                   Keep the response under 100 words and focus only on factual information.
                   Format as bullet points if multiple facts are included.` }];

    const response = await llmService.chat(
      input,
      null,
      {
        temperature: 0.5,
        max_tokens: 150,
      }
    );
    
    return response.output_text;
  } catch (error) {
    console.error('Error getting wine facts:', error);
    return "";
  }
}