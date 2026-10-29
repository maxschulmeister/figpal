import { SYSTEM_PROMPT } from "./prompts";

async function inference(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ code: string }> {
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://figma.com",
        "X-Title": "FigPal",
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "prompt",
            strict: true,
            schema: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  description:
                    "The generated function that fulfills the requirements of the user. It can not have any errors and must be executable using eval() in the Figma plugin environment. DO NOT output anything else than the function!",
                },
              },
            },
          },
          required: ["code"],
          additionalProperties: false,
        },
        temperature: 0.1,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error("Invalid response format from OpenRouter API");
  }

  return JSON.parse(data.choices[0].message.content);
}

export default async function () {
  figma.on("run", async ({ parameters }) => {
    if (!parameters || !parameters.prompt) {
      figma.closePlugin("No prompt provided");
      return;
    }

    // const userPrompt = parameters.prompt;
    const userPrompt = "set the variable 'spacing-3xs' to 10";
    console.log("Received prompt:", userPrompt);
    try {
      // Show loading notification
      figma.notify("Generating code with AI...");

      // Get API key and model from environment variables
      const apiKey = process.env.OPENROUTER_API_KEY;
      const modelName = "openai/o4-mini-high";

      if (!apiKey) {
        figma.notify(
          "OpenRouter API key not configured. Please set OPENROUTER_API_KEY in your .env file.",
          { error: true }
        );
        figma.closePlugin();
        return;
      }

      if (!modelName) {
        figma.notify(
          "Model not configured. Please set MODEL in your .env file.",
          { error: true }
        );
        figma.closePlugin();
        return;
      }

      // Generate code using direct OpenRouter API call
      const response = await inference(
        apiKey,
        modelName,
        SYSTEM_PROMPT,
        userPrompt
      );

      console.log("modelName", modelName);
      console.log("Response:", response);

      if (!response.code) {
        figma.notify("No code generated", { error: true });
        figma.closePlugin();
      }

      const generatedCode = response.code;

      console.log("Generated code:", generatedCode);

      // Basic validation - ensure it's a function
      if (
        !generatedCode.includes("async function main()") &&
        !generatedCode.includes("function main()")
      ) {
        throw new Error(
          "Generated code does not contain a valid main function"
        );
      }

      // Validate for potential security issues (basic checks)
      // const forbiddenKeywords = [
      //   "fetch",
      //   "XMLHttpRequest",
      //   "import",
      //   "require",
      //   "eval",
      // ];
      // const hasForbiddenContent = forbiddenKeywords.some((keyword) =>
      //   generatedCode.includes(keyword)
      // );

      // if (hasForbiddenContent) {
      //   throw new Error("Generated code contains forbidden operations");
      // }

      figma.notify("Executing generated code...");

      try {
        // Create a function from the code string and execute it
        const executeCode = new Function(generatedCode + "\nreturn main();");
        await executeCode();
      } catch (execError: unknown) {
        const errorMessage =
          execError instanceof Error
            ? execError.message
            : "Unknown execution error";
        console.error("Code execution error:", execError);
        figma.notify(`Execution error: ${errorMessage}`, { error: true });
        figma.closePlugin();
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Plugin error:", error);
      figma.notify(`Error: ${errorMessage}`, { error: true });
      figma.closePlugin();
    }
  });
}
