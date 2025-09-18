import { Agent } from '../../src/Agent.js';

export class QASubAgent {
  constructor(model = 'gpt-4o-mini') {
    this.model = model;
    this.agent = new Agent(model, this.getQATools());
  }

  getQATools() {
    return [
      {
        type: "function",
        name: "search_knowledge_base",
        description: "Search the knowledge base for information to answer questions",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query to find relevant information" },
            category: { type: "string", description: "Category of information to search (optional)" }
          },
          required: ["query"]
        },
        func: async (args) => {
          console.log(`Searching knowledge base for: ${args.query}`);
          
          // Simulate search processing time
          await new Promise(resolve => setTimeout(resolve, 1200));
          
          const searchResult = this.searchKnowledgeBase(args.query, args.category);
          console.log(`Search result: ${searchResult}`);
          
          return searchResult;
        }
      },
      {
        type: "function",
        name: "calculate_answer",
        description: "Calculate mathematical answers or perform computations",
        parameters: {
          type: "object",
          properties: {
            expression: { type: "string", description: "Mathematical expression to calculate" }
          },
          required: ["expression"]
        },
        func: async (args) => {
          console.log(`Calculating: ${args.expression}`);
          
          // Simulate calculation processing time
          await new Promise(resolve => setTimeout(resolve, 800));
          
          try {
            const result = this.evaluateExpression(args.expression);
            console.log(`Calculation result: ${result}`);
            return result;
          } catch (error) {
            console.log(`Calculation error: ${error.message}`);
            return `Error: ${error.message}`;
          }
        }
      },
      {
        type: "function",
        name: "get_fact",
        description: "Get factual information about various topics",
        parameters: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Topic to get information about" },
            aspect: { type: "string", description: "Specific aspect of the topic (optional)" }
          },
          required: ["topic"]
        },
        func: async (args) => {
          console.log(`Getting fact about: ${args.topic}`);
          
          // Simulate fact retrieval processing time
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const fact = this.getFact(args.topic, args.aspect);
          console.log(`Fact retrieved: ${fact}`);
          
          return fact;
        }
      }
    ];
  }

  async answerQuestion(question) {
    this.agent.addInput("user", `Please answer this question: ${question}`);
    
    const result = await this.agent.run();
    
    if (result.type === "function_call") {
      return result.result;
    } else {
      // Fallback to simulated answer if agent doesn't use tools
      return this.simulateAnswer(question);
    }
  }

  // Simulated knowledge base search for demo purposes
  searchKnowledgeBase(query, category = null) {
    const knowledgeBase = {
      'capital': {
        'France': 'Paris',
        'Germany': 'Berlin',
        'Spain': 'Madrid',
        'Italy': 'Rome',
        'Japan': 'Tokyo',
        'China': 'Beijing',
        'Russia': 'Moscow',
        'United States': 'Washington D.C.',
        'Canada': 'Ottawa',
        'Australia': 'Canberra'
      },
      'population': {
        'France': '67 million',
        'Germany': '83 million',
        'Spain': '47 million',
        'Italy': '60 million',
        'Japan': '126 million',
        'China': '1.4 billion',
        'Russia': '144 million',
        'United States': '331 million',
        'Canada': '38 million',
        'Australia': '25 million'
      },
      'language': {
        'France': 'French',
        'Germany': 'German',
        'Spain': 'Spanish',
        'Italy': 'Italian',
        'Japan': 'Japanese',
        'China': 'Chinese (Mandarin)',
        'Russia': 'Russian',
        'United States': 'English',
        'Canada': 'English and French',
        'Australia': 'English'
      }
    };

    const queryLower = query.toLowerCase();
    
    // Search for country names
    for (const [country, info] of Object.entries(knowledgeBase.capital)) {
      if (queryLower.includes(country.toLowerCase())) {
        if (category === 'population') {
          return knowledgeBase.population[country];
        } else if (category === 'language') {
          return knowledgeBase.language[country];
        } else {
          return knowledgeBase.capital[country];
        }
      }
    }

    // Search for general topics
    if (queryLower.includes('capital')) {
      return 'Capitals are the primary cities where a country\'s government is located.';
    } else if (queryLower.includes('population')) {
      return 'Population refers to the total number of people living in a specific area or country.';
    } else if (queryLower.includes('language')) {
      return 'Languages are systems of communication used by humans, with thousands of different languages spoken worldwide.';
    }

    return `I found some information about "${query}" in the knowledge base.`;
  }

  // Simulated mathematical expression evaluation
  evaluateExpression(expression) {
    // Simple and safe expression evaluation for demo purposes
    const safeExpression = expression.replace(/[^0-9+\-*/().\s]/g, '');
    
    try {
      // Use Function constructor for safe evaluation (still be careful in production)
      const result = new Function(`return ${safeExpression}`)();
      return result;
    } catch (error) {
      throw new Error(`Invalid mathematical expression: ${expression}`);
    }
  }

  // Simulated fact retrieval
  getFact(topic, aspect = null) {
    const facts = {
      'France': {
        'general': 'France is a country in Western Europe known for its culture, cuisine, and history.',
        'capital': 'The capital of France is Paris.',
        'population': 'France has a population of approximately 67 million people.',
        'language': 'The official language of France is French.',
        'famous': 'France is famous for the Eiffel Tower, Louvre Museum, and French cuisine.'
      },
      'Germany': {
        'general': 'Germany is a country in Central Europe known for its engineering and beer.',
        'capital': 'The capital of Germany is Berlin.',
        'population': 'Germany has a population of approximately 83 million people.',
        'language': 'The official language of Germany is German.',
        'famous': 'Germany is famous for Oktoberfest, BMW cars, and classical music.'
      },
      'Spain': {
        'general': 'Spain is a country in Southern Europe known for its beaches and culture.',
        'capital': 'The capital of Spain is Madrid.',
        'population': 'Spain has a population of approximately 47 million people.',
        'language': 'The official language of Spain is Spanish (Castilian).',
        'famous': 'Spain is famous for flamenco dancing, paella, and the Sagrada Familia.'
      }
    };

    const topicLower = topic.toLowerCase();
    
    for (const [key, info] of Object.entries(facts)) {
      if (topicLower.includes(key.toLowerCase())) {
        if (aspect && info[aspect.toLowerCase()]) {
          return info[aspect.toLowerCase()];
        } else {
          return info.general;
        }
      }
    }

    return `I have some information about ${topic}. What specific aspect would you like to know?`;
  }

  // Fallback simulated answer
  simulateAnswer(question) {
    const questionLower = question.toLowerCase();
    
    if (questionLower.includes('capital')) {
      return 'The capital is the primary city where a country\'s government is located.';
    } else if (questionLower.includes('population')) {
      return 'Population refers to the total number of people living in a specific area.';
    } else if (questionLower.includes('language')) {
      return 'Languages are systems of communication used by humans worldwide.';
    } else if (questionLower.includes('france')) {
      return 'France is a country in Western Europe with Paris as its capital.';
    } else if (questionLower.includes('germany')) {
      return 'Germany is a country in Central Europe with Berlin as its capital.';
    } else if (questionLower.includes('spain')) {
      return 'Spain is a country in Southern Europe with Madrid as its capital.';
    } else {
      return `I can help you with information about ${question}. Let me search my knowledge base.`;
    }
  }

  async run() {
    return await this.agent.run();
  }

  addInput(role, message) {
    this.agent.addInput(role, message);
  }
} 