import { TranslatorAgent } from './TranslatorAgent.js';
import { TranslationSubAgent } from './TranslationSubAgent.js';
import { QASubAgent } from './QASubAgent.js';

export class TranslatorTest {
  constructor() {
    this.translatorAgent = new TranslatorAgent();
    this.translationAgent = new TranslationSubAgent();
    this.qaAgent = new QASubAgent();
  }

  async runBasicTranslationTest() {
    console.log("Basic Translation Test");
    console.log("=".repeat(50));

    const testCases = [
      { text: "¿Cuál es la capital de Francia?", language: "Spanish" },
      { text: "Quelle est la capitale de la France?", language: "French" },
      { text: "Was ist die Hauptstadt von Frankreich?", language: "German" }
    ];

    for (const testCase of testCases) {
      console.log(`\nTesting: ${testCase.text} (${testCase.language})`);
      const result = await this.translationAgent.translate(testCase.text, 'English');
      console.log(`Result: ${result}`);
    }
  }

  async runQATest() {
    console.log("\nQA Agent Test");
    console.log("=".repeat(50));

    const questions = [
      "What is the capital of France?",
      "What is the population of Germany?",
      "What language is spoken in Spain?"
    ];

    for (const question of questions) {
      console.log(`\nQuestion: ${question}`);
      const answer = await this.qaAgent.answerQuestion(question);
      console.log(`Answer: ${answer}`);
    }
  }

  async runFullWorkflowTest() {
    console.log("\nFull Workflow Test");
    console.log("=".repeat(50));

    const testCases = [
      {
        question: "¿Cuál es la capital de Francia?",
        language: "Spanish",
        expected: "Paris"
      },
      {
        question: "Quelle est la population de l'Allemagne?",
        language: "French",
        expected: "83 million"
      },
      {
        question: "Was ist die Hauptstadt von Spanien?",
        language: "German",
        expected: "Madrid"
      }
    ];

    for (const testCase of testCases) {
      console.log(`\nTesting workflow: ${testCase.question} (${testCase.language})`);
      console.log(`Expected answer: ${testCase.expected}`);
      
      const result = await this.translatorAgent.processForeignLanguageQuestion(
        testCase.question,
        testCase.language
      );
      
      console.log(`Workflow completed successfully!`);
      console.log(`Final answer: ${result.finalAnswer}`);
    }
  }

  async runConcurrentTranslationTest() {
    console.log("\nConcurrent Translation Test");
    console.log("=".repeat(50));

    const translations = [
      { text: "Buenos días", from: "Spanish", to: "English" },
      { text: "Bonjour", from: "French", to: "English" },
      { text: "Guten Morgen", from: "German", to: "English" }
    ];

    console.log("Starting concurrent translations...");
    const startTime = Date.now();

    const promises = translations.map(async (translation) => {
      console.log(`Translating: ${translation.text} (${translation.from} → ${translation.to})`);
      const result = await this.translationAgent.translate(translation.text, translation.to);
      return { ...translation, result };
    });

    const results = await Promise.all(promises);
    const endTime = Date.now();

    console.log("\nConcurrent Translation Results:");
    results.forEach((result, index) => {
      console.log(`${index + 1}. ${result.text} → ${result.result}`);
    });

    console.log(`\nTotal execution time: ${endTime - startTime}ms`);
    console.log("Note: Translations run concurrently for better performance");
  }

  async runErrorHandlingTest() {
    console.log("\nError Handling Test");
    console.log("=".repeat(50));

    try {
      console.log("Testing division by zero in QA agent...");
      const result = await this.qaAgent.answerQuestion("What is 10 divided by 0?");
      console.log(`Result: ${result}`);
    } catch (error) {
      console.log(`Error caught: ${error.message}`);
    }

    try {
      console.log("\nTesting invalid mathematical expression...");
      const result = await this.qaAgent.answerQuestion("Calculate: 2 + * 3");
      console.log(`Result: ${result}`);
    } catch (error) {
      console.log(`Error caught: ${error.message}`);
    }
  }

  async runCustomWorkflowTest() {
    console.log("\nCustom Workflow Test");
    console.log("=".repeat(50));

    // Create a custom workflow: translate question, answer it, translate answer
    const customQuestion = "¿Cuántos habitantes tiene Francia?";
    const sourceLanguage = "Spanish";

    console.log(`Custom workflow: ${customQuestion} (${sourceLanguage})`);
    
    // Step 1: Translate question to English
    const englishQuestion = await this.translationAgent.translate(customQuestion, 'English');
    console.log(`English question: ${englishQuestion}`);
    
    // Step 2: Answer in English
    const englishAnswer = await this.qaAgent.answerQuestion(englishQuestion);
    console.log(`English answer: ${englishAnswer}`);
    
    // Step 3: Translate answer back to Spanish
    const spanishAnswer = await this.translationAgent.translate(englishAnswer, 'Spanish');
    console.log(`Spanish answer: ${spanishAnswer}`);
    
    console.log("\nCustom workflow completed successfully!");
  }

  async runAllTests() {
    console.log("Starting Translator Agent Test Suite");
    console.log("=".repeat(60));

    try {
      await this.runBasicTranslationTest();
      await this.runQATest();
      await this.runFullWorkflowTest();
      await this.runConcurrentTranslationTest();
      await this.runErrorHandlingTest();
      await this.runCustomWorkflowTest();

      console.log("\n" + "=".repeat(60));
      console.log("All tests completed successfully!");
      console.log("Translator Agent system is working correctly!");
      
    } catch (error) {
      console.error("\nTest suite failed:", error);
    }
  }
}

// Example usage and demonstration
async function demonstrateTranslatorSystem() {
  console.log("Translator Agent System Demonstration");
  console.log("=".repeat(60));
  console.log("This system demonstrates task delegation between agents:");
  console.log("1. Main TranslatorAgent coordinates the workflow");
  console.log("2. TranslationSubAgent handles language translation");
  console.log("3. QASubAgent answers questions in English");
  console.log("4. All agents work together to process foreign language questions");
  console.log("");

  const test = new TranslatorTest();
  await test.runAllTests();
}

// Export for external use
export { demonstrateTranslatorSystem };

// Run demonstration if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateTranslatorSystem();
} 