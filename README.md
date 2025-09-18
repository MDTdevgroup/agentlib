## Setup

1. **Add `.env` file**  
   - Create a `.env` file in the project root.  
   - Add your LLM provider API keys following the template in `.env.example`.  

2. **Quickstart**  
   - See the `./examples` directory for usage.  
   - The **translator example** is the easiest way to get started.  

3. **Supported Providers**  
   - Google **Gemini**  
   - **OpenAI**  

## Usage

**LLM Service Input Format**

The LLM service input parameter expects the same format used by OpenAI. Which is an array of JSON objects with keys 'role' and 'content'.

Example:

```js
input: [
  {
    role: "developer",
    content: "Talk like a pirate."
  },
  {
    role: "user",
    content: "Are semicolons optional in JavaScript?"
  }
]
```

For other providers, a translation script must be implemented to conform to their specific syntax.

https://platform.openai.com/docs/guides/text

**Options Argument**

The `options` parameter is *provider-specific*.  
Developers are responsible for ensuring that any extra options passed follow the syntax and requirements of the chosen provider (e.g. OpenAI, Gemini).  

Incorrect or unsupported options may cause errors or be ignored by the provider.


