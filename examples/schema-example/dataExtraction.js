import { Agent } from '../../src/Agent.js';
import { z } from 'zod';

// Define input schema for research paper text
const ResearchPaperInput = z.object({
  text: z.string().min(50).describe("The research paper text to extract data from"),
  extractionType: z.enum(['basic', 'detailed', 'metadata']).describe("Type of extraction to perform"),
  language: z.string().optional().describe("Language of the paper (defaults to English)")
});

// Define output schema for extracted research paper data
const ResearchPaperExtraction = z.object({
  title: z.string().describe("The title of the research paper"),
  authors: z.array(z.string()).describe("List of author names"),
  abstract: z.string().describe("The abstract or summary of the paper"),
  keywords: z.array(z.string()).describe("Key terms and concepts from the paper"),
  methodology: z.string().optional().describe("Research methodology used"),
  conclusions: z.array(z.string()).optional().describe("Main conclusions from the research")
});

// Define schema for content moderation
const ContentCompliance = z.object({
  is_violating: z.boolean().describe("Whether the content violates guidelines"),
  category: z.enum(['violence', 'sexual', 'self_harm', 'harassment', 'none']).describe("Category of violation if any"),
  explanation_if_violating: z.string().nullable().describe("Explanation of why content is violating"),
  confidence_score: z.number().min(0).max(1).describe("Confidence in the assessment (0-1)")
});

// Input schema for moderation
const ModerationInput = z.object({
  content: z.string().describe("Content to moderate"),
  context: z.string().optional().describe("Additional context for moderation")
});

async function runDataExtractionExample() {
  console.log('📄 Research Paper Data Extraction Example\n');

  const agent = new Agent({
    model: 'gpt-4o-mini',
    inputSchema: ResearchPaperInput,
    outputSchema: ResearchPaperExtraction
  });

  // Sample research paper text
  const samplePaper = {
    text: `
      Application of Quantum Algorithms in Interstellar Navigation: A New Frontier
      
      Authors: Dr. Stella Voyager, Dr. Nova Star, Dr. Lyra Hunter
      
      Abstract: This paper investigates the utilization of quantum algorithms to improve interstellar navigation systems. By leveraging quantum superposition and entanglement, our proposed navigation system can calculate optimal travel paths through space-time anomalies more efficiently than classical methods. 
      
      Our methodology involved developing a quantum-enhanced pathfinding algorithm using Grover's search and Shor's algorithm for factoring large orbital mechanics calculations. We tested our approach using simulated space environments with various gravitational anomalies.
      
      Experimental simulations suggest a significant reduction in travel time and fuel consumption for interstellar missions. The quantum approach showed 300% improvement in calculation speed compared to classical navigation systems.
      
      Keywords: Quantum algorithms, interstellar navigation, space-time anomalies, quantum superposition, quantum entanglement, space travel, orbital mechanics
      
      Conclusions: Quantum computing offers unprecedented advantages for space navigation. The integration of quantum algorithms into spacecraft navigation systems could revolutionize interstellar travel. Future work should focus on hardware implementation and real-world testing.
    `,
    extractionType: 'detailed',
    language: 'English'
  };

  agent.addInput({
    role: 'system',
    content: 'You are an expert at structured data extraction from academic papers. Extract the requested information accurately and comprehensively.'
  });

  agent.addInput({
    role: 'user',
    content: `Please extract structured data from this research paper. Extraction type: ${samplePaper.extractionType}. Paper text: ${samplePaper.text}`
  });

  try {
    const result = await agent.run();
    
    console.log('📊 Extraction Results:');
    console.log('Status:', result.status);
    console.log('Model:', result.model);
    console.log('Tokens used:', result.usage.total_tokens);
    console.log();

    const responseText = result.output_text;
    console.log('📝 Structured Extraction:');
    console.log(responseText);
    console.log();

    // Parse and display structured data
    try {
      const extractedData = JSON.parse(responseText);
      
      console.log('🔍 Parsed Research Data:');
      console.log(`Title: ${extractedData.title}`);
      console.log(`Authors: ${extractedData.authors.join(', ')}`);
      console.log(`Keywords (${extractedData.keywords.length}): ${extractedData.keywords.join(', ')}`);
      console.log(`Abstract: ${extractedData.abstract.substring(0, 100)}...`);
      
      if (extractedData.methodology) {
        console.log(`Methodology: ${extractedData.methodology}`);
      }
      
      if (extractedData.conclusions) {
        console.log('Conclusions:');
        extractedData.conclusions.forEach((conclusion, index) => {
          console.log(`  ${index + 1}. ${conclusion}`);
        });
      }
      
    } catch (parseError) {
      console.log('⚠️  Could not parse response as JSON:', parseError.message);
    }

  } catch (error) {
    console.error('❌ Extraction Error:', error.message);
  }

  console.log('\n' + '='.repeat(60) + '\n');
}

async function runModerationExample() {
  console.log('🛡️ Content Moderation Example\n');

  const agent = new Agent({
    model: 'gpt-4o-mini',
    inputSchema: ModerationInput,
    outputSchema: ContentCompliance
  });

  const testContents = [
    {
      content: "How do I prepare for a job interview?",
      context: "Career advice question"
    },
    {
      content: "I'm feeling really frustrated with my project and want to give up.",
      context: "Personal expression"
    },
    {
      content: "This is a test of inappropriate content that should be flagged",
      context: "Testing moderation system"
    }
  ];

  for (const testContent of testContents) {
    console.log(`📝 Moderating: "${testContent.content}"`);
    console.log(`🔍 Context: ${testContent.context}\n`);

    agent.addInput({
      role: 'system',
      content: 'You are a content moderation system. Analyze the provided content for policy violations including violence, sexual content, self-harm, and harassment. Be accurate and provide confidence scores.'
    });

    agent.addInput({
      role: 'user',
      content: `Please moderate this content: "${testContent.content}" with context: "${testContent.context}"`
    });

    try {
      const result = await agent.run();
      const responseText = result.output_text;
      
      console.log('🛡️ Moderation Result:');
      console.log(responseText);
      console.log();

      // Parse moderation results
      try {
        const moderation = JSON.parse(responseText);
        
        console.log('📊 Moderation Analysis:');
        console.log(`Violating: ${moderation.is_violating ? '❌ YES' : '✅ NO'}`);
        console.log(`Category: ${moderation.category}`);
        console.log(`Confidence: ${(moderation.confidence_score * 100).toFixed(1)}%`);
        
        if (moderation.explanation_if_violating) {
          console.log(`Explanation: ${moderation.explanation_if_violating}`);
        }
        
      } catch (parseError) {
        console.log('⚠️  Could not parse moderation response:', parseError.message);
      }

    } catch (error) {
      console.error('❌ Moderation Error:', error.message);
    }

    console.log('\n' + '-'.repeat(40) + '\n');
    agent.clearInputs();
  }
}

async function demonstrateInputValidation() {
  console.log('✅ Input Validation Examples\n');

  const agent = new Agent({
    model: 'gpt-4o-mini',
    inputSchema: ResearchPaperInput,
    outputSchema: ResearchPaperExtraction
  });

  // Test cases for input validation
  const testInputs = [
    {
      name: "Valid input",
      data: {
        text: "This is a valid research paper text that meets the minimum length requirement of 50 characters.",
        extractionType: "basic"
      }
    },
    {
      name: "Text too short",
      data: {
        text: "Too short",
        extractionType: "basic"
      }
    },
    {
      name: "Invalid extraction type",
      data: {
        text: "This is a valid research paper text that meets the minimum length requirement.",
        extractionType: "invalid_type"
      }
    }
  ];

  for (const testCase of testInputs) {
    console.log(`🧪 Testing: ${testCase.name}`);
    
    try {
      // The input validation happens in the LLM service
      agent.addInput({
        role: 'system',
        content: 'Extract research paper data.'
      });

      agent.addInput({
        role: 'user',
        content: `Extract from: ${JSON.stringify(testCase.data)}`
      });

      const result = await agent.run();
      console.log(`✅ ${testCase.name}: Passed validation`);
      console.log(`Response status: ${result.status}`);
      
    } catch (error) {
      console.log(`❌ ${testCase.name}: ${error.message}`);
    }

    console.log();
    agent.clearInputs();
  }
}

async function main() {
  try {
    await runDataExtractionExample();
    await runModerationExample();
    await demonstrateInputValidation();
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

main().catch(console.error);
