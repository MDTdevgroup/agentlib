import { Agent } from '../Agent.js';

export class TranslationSubAgent {
  constructor(model = 'gpt-4o-mini') {
    this.model = model;
    this.agent = new Agent(model, this.getTranslationTools());
  }

  getTranslationTools() {
    return [
      {
        type: "function",
        name: "translate_text",
        description: "Translate text from one language to another",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to be translated" },
            sourceLanguage: { type: "string", description: "Source language of the text" },
            targetLanguage: { type: "string", description: "Target language for translation" }
          },
          required: ["text", "sourceLanguage", "targetLanguage"]
        },
        func: async (args) => {
          console.log(`Translating: ${args.text} (${args.sourceLanguage} → ${args.targetLanguage})`);
          
          // Simulate translation processing time
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          // For demo purposes, we'll do some basic translations
          // In a real implementation, this would call an actual translation API
          const translation = this.simulateTranslation(args.text, args.sourceLanguage, args.targetLanguage);
          
          console.log(`Translation result: ${translation}`);
          return translation;
        }
      },
      {
        type: "function",
        name: "detect_language",
        description: "Detect the language of given text",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to detect language for" }
          },
          required: ["text"]
        },
        func: async (args) => {
          console.log(`Detecting language for: ${args.text}`);
          
          // Simulate language detection processing time
          await new Promise(resolve => setTimeout(resolve, 800));
          
          const detectedLanguage = this.simulateLanguageDetection(args.text);
          console.log(`Detected language: ${detectedLanguage}`);
          
          return detectedLanguage;
        }
      }
    ];
  }

  async translate(text, targetLanguage, sourceLanguage = null) {
    if (!sourceLanguage) {
      // Auto-detect source language if not provided
      sourceLanguage = await this.detectLanguage(text);
    }

    this.agent.addInput("user", `Please translate the following text to ${targetLanguage}: "${text}"`);
    
    const result = await this.agent.run();
    
    if (result.type === "function_call" && result.tool === "translate_text") {
      return result.result;
    } else {
      // Fallback to simulated translation if agent doesn't use the tool
      return this.simulateTranslation(text, sourceLanguage, targetLanguage);
    }
  }

  async detectLanguage(text) {
    this.agent.addInput("user", `What language is this text written in: "${text}"`);
    
    const result = await this.agent.run();
    
    if (result.type === "function_call" && result.tool === "detect_language") {
      return result.result;
    } else {
      // Fallback to simulated language detection
      return this.simulateLanguageDetection(text);
    }
  }

  // Simulated translation for demo purposes
  simulateTranslation(text, sourceLanguage, targetLanguage) {
    const translations = {
      'Spanish': {
        'English': {
          '¿Cuál es la capital de Francia?': 'What is the capital of France?',
          '¿Cómo te llamas?': 'What is your name?',
          '¿Qué hora es?': 'What time is it?',
          'Buenos días': 'Good morning',
          'Gracias': 'Thank you'
        }
      },
      'French': {
        'English': {
          'Quelle est la capitale de la France?': 'What is the capital of France?',
          'Comment vous appelez-vous?': 'What is your name?',
          'Quelle heure est-il?': 'What time is it?',
          'Bonjour': 'Good morning',
          'Merci': 'Thank you'
        }
      },
      'German': {
        'English': {
          'Was ist die Hauptstadt von Frankreich?': 'What is the capital of France?',
          'Wie heißen Sie?': 'What is your name?',
          'Wie spät ist es?': 'What time is it?',
          'Guten Morgen': 'Good morning',
          'Danke': 'Thank you'
        }
      },
      'English': {
        'Spanish': {
          'What is the capital of France?': '¿Cuál es la capital de Francia?',
          'What is your name?': '¿Cómo te llamas?',
          'What time is it?': '¿Qué hora es?',
          'Good morning': 'Buenos días',
          'Thank you': 'Gracias'
        },
        'French': {
          'What is the capital of France?': 'Quelle est la capitale de la France?',
          'What is your name?': 'Comment vous appelez-vous?',
          'What time is it?': 'Quelle heure est-il?',
          'Good morning': 'Bonjour',
          'Thank you': 'Merci'
        },
        'German': {
          'What is the capital of France?': 'Was ist die Hauptstadt von Frankreich?',
          'What is your name?': 'Wie heißen Sie?',
          'What time is it?': 'Wie spät ist es?',
          'Good morning': 'Guten Morgen',
          'Thank you': 'Danke'
        }
      }
    };

    // Check if we have a direct translation
    if (translations[sourceLanguage] && translations[sourceLanguage][targetLanguage]) {
      const directTranslation = translations[sourceLanguage][targetLanguage][text];
      if (directTranslation) {
        return directTranslation;
      }
    }

    // If no direct translation, create a simulated one
    if (targetLanguage === 'English') {
      return `[Translated to English]: ${text}`;
    } else {
      return `[Translated to ${targetLanguage}]: ${text}`;
    }
  }

  // Simulated language detection for demo purposes
  simulateLanguageDetection(text) {
    const languagePatterns = {
      'Spanish': /[áéíóúñ¿¡]/,
      'French': /[àâäéèêëïîôöùûüÿç]/,
      'German': /[äöüßÄÖÜ]/
    };

    for (const [language, pattern] of Object.entries(languagePatterns)) {
      if (pattern.test(text)) {
        return language;
      }
    }

    // Default to English if no special characters detected
    return 'English';
  }

  async run() {
    return await this.agent.run();
  }

  addInput(role, message) {
    this.agent.addInput(role, message);
  }
} 