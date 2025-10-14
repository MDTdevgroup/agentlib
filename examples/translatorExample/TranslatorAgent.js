import { Agent } from '../../src/Agent.js';
import { TranslationSubAgent } from './TranslationSubAgent.js';
import { QASubAgent } from './QASubAgent.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

export class TranslatorAgent {
  constructor() {
    this.translationAgent = new TranslationSubAgent();
    this.qaAgent = new QASubAgent();
    this.mainAgent = new Agent('openai', process.env.OPENAI_API_KEY, {tools: this.getMainTools()});
  }

  getMainTools() {
    return [
      {
        type: "function",
        name: "delegate_translation",
        description: "Delegate a translation task to the translation sub-agent",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to be translated" },
            targetLanguage: { type: "string", description: "Target language for translation" }
          },
          required: ["text", "targetLanguage"]
        },
        func: async (args) => {
          console.log(`Delegating translation to sub-agent: ${args.text} → ${args.targetLanguage}`);
          const result = await this.translationAgent.translate(args.text, args.targetLanguage);
          console.log(`Translation completed: ${result}`);
          return result;
        }
      },
      {
        type: "function",
        name: "delegate_qa",
        description: "Delegate a question-answering task to the QA sub-agent",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "Question to be answered" }
          },
          required: ["question"]
        },
        func: async (args) => {
          console.log(`Delegating QA to sub-agent: ${args.question}`);
          const result = await this.qaAgent.answerQuestion(args.question);
          console.log(`QA completed: ${result}`);
          return result;
        }
      }
    ];
  }

  async processForeignLanguageQuestion(question, sourceLanguage) {
    console.log(`Processing question in ${sourceLanguage}: ${question}`);
    console.log("=".repeat(60));

    // Step 1: Translate question to English
    console.log("Step 1: Translating question to English");
    const englishQuestion = await this.translationAgent.translate(question, 'English');
    console.log(`English question: ${englishQuestion}`);
    console.log("");

    // Step 2: Answer the question in English
    console.log("Step 2: Answering question in English");
    const englishAnswer = await this.qaAgent.answerQuestion(englishQuestion);
    console.log(`English answer: ${englishAnswer}`);
    console.log("");

    // Step 3: Translate answer back to original language
    console.log(`Step 3: Translating answer back to ${sourceLanguage}`);
    const finalAnswer = await this.translationAgent.translate(englishAnswer, sourceLanguage);
    console.log(`${sourceLanguage} answer: ${finalAnswer}`);
    console.log("");

    console.log("=".repeat(60));
    console.log("Final Result:");
    console.log(`Original (${sourceLanguage}): ${question}`);
    console.log(`English: ${englishQuestion}`);
    console.log(`Answer (English): ${englishAnswer}`);
    console.log(`Final (${sourceLanguage}): ${finalAnswer}`);

    return {
      originalQuestion: question,
      sourceLanguage: sourceLanguage,
      englishQuestion: englishQuestion,
      englishAnswer: englishAnswer,
      finalAnswer: finalAnswer
    };
  }

  async run() {
    return await this.mainAgent.run();
  }

  addInput(input) {
    this.mainAgent.addInput(input);
  }
} 