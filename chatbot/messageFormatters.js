/**
 * Format conversation history for OpenAI API
 * @param {Array} conversationHistory - Array of conversation objects
 * @returns {Array} - Formatted array of message objects for OpenAI API
 */
export function formatConversation(conversationHistory = []) {
  if (!conversationHistory || !Array.isArray(conversationHistory)) {
    return [];
  }
  
  return conversationHistory
    .filter(message => message && message.content && typeof message.content === 'string')
    .map(message => ({
      role: message.role,
      content: message.content
    }));
}

/**
 * Format memory data for inclusion in prompts
 * @param {Array} memories - Array of memory objects from the memory system
 * @returns {String} - Formatted string representation of memories
 */
export function formatMemoriesForPrompt(memories = []) {
  if (!memories || memories.length === 0) {
    return "No preference history available yet.";
  }
  
  // Sort memories by importance
  const sortedMemories = [...memories].sort((a, b) => (b.importance || 0) - (a.importance || 0));
  
  // Format each memory as a line
  const formattedMemories = sortedMemories.map(memory => {
    let typeSymbol = "•";
    if (memory.type === "like" || memory.type === "favorite") typeSymbol = "👍";
    if (memory.type === "dislike" || memory.type === "avoid") typeSymbol = "👎";
    
    // Format based on memory structure
    let description = "";
    if (memory.wineName) {
      description = `${memory.wineName}`;
      if (memory.variety) description += ` (${memory.variety})`;
    } else if (memory.wineType) {
      description = `${memory.wineType} wines`;
    } else if (memory.content) {
      description = memory.content;
    }
    
    // Add comment if available
    const comment = memory.userComment ? `: "${memory.userComment}"` : "";
    
    return `${typeSymbol} ${memory.type || "Noted"} ${description}${comment}`;
  });
  
  return formattedMemories.join("\n");
}

/**
 * Format a response message for structured display
 * @param {String} message - Raw message content
 * @returns {Object} - Parsed message with any structured data
 */
export function formatResponseMessage(message) {
  // Check if message contains a recommendation section
  const hasRecommendation = message.includes("RECOMMENDATION:") || 
                           message.includes("I recommend") ||
                           message.includes("I suggest");
  
  // Check if message contains a knowledge section
  const hasKnowledgeShare = message.includes("FUN FACT:") || 
                           message.includes("DID YOU KNOW:") ||
                           message.includes("wine fact");
  
  return {
    content: message,
    hasRecommendation,
    hasKnowledgeShare
  };
}