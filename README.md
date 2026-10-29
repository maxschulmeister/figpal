# FigPal - AI Code Generator

An AI-powered Figma plugin that generates and executes custom Figma Plugin API functions based on natural language prompts.

## Overview

FigPal enables you to automate Figma tasks through natural language. Simply describe what you want to create or do in Figma, and the AI will generate and execute the appropriate code using the Figma Plugin API.

### Examples of what you can do:

- "Create a red rectangle in the center of the canvas"
- "Duplicate the selected layer and rotate it 45 degrees"
- "Create a text element that says 'Hello World' in Arial"
- "Group all selected objects"
- "Change the fill color of selected shapes to blue"

## Features

- **No UI Required**: Uses Figma's quick actions menu for input
- **AI-Powered**: Leverages OpenRouter's GPT-4 for intelligent code generation
- **Immediate Execution**: Generated code runs instantly with visual feedback
- **Security Validated**: Basic validation to prevent unsafe operations
- **Error Handling**: Clear error messages and logging for debugging

## Setup

### Prerequisites

1. Node.js 18+ and pnpm installed
2. An OpenRouter API key ([Get one here](https://openrouter.ai/))
3. Figma desktop app

### Installation

1. Clone this repository
2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Configure your OpenRouter API key:

   - Create a `.env` file in the project root
   - Add your API key and preferred model:
     ```env
     OPENROUTER_API_KEY=your-actual-api-key
     MODEL=openai/gpt-4o
     ```

   **Available Models:**

   - `openai/gpt-4o` (recommended, most capable)
   - `openai/gpt-4o-mini` (faster, cheaper)
   - `anthropic/claude-3.5-sonnet` (alternative, good for code)
   - `moonshotai/kimi-k2:free` (free option, limited capabilities)

4. Build the plugin:
   ```bash
   pnpm build
   ```

### Development

For development with hot reload:

```bash
pnpm dev
```

## Usage

1. **Install the plugin** in Figma by importing the built plugin
2. **Run the plugin** from Figma's plugins menu or use the quick action:
   - Press `Cmd/Ctrl + /` to open quick actions
   - Type "FigPal" and select the plugin
3. **Enter your prompt** when prompted (e.g., "Create a blue circle")
4. **Wait for execution** - the AI will generate and run the code automatically

## How It Works

1. **Prompt Input**: You provide a natural language description of what you want to do
2. **AI Generation**: The prompt is sent to the configured model via OpenRouter API with a specialized system prompt
3. **Code Validation**: Basic security checks are performed on the generated code
4. **Execution**: The code is executed in Figma's plugin environment
5. **Feedback**: Success or error messages are displayed via Figma notifications

## Technical Details

### Architecture

- **Frontend**: No UI (parameter-based input only)
- **AI Provider**: Direct HTTP calls to OpenRouter API
- **Execution**: Dynamic code generation and execution using `eval`
- **Security**: Basic keyword filtering and validation

### Supported Operations

The plugin can generate code for any operation supported by the Figma Plugin API, including:

- Creating shapes, text, and other nodes
- Modifying existing selections
- Setting properties like colors, fonts, and positioning
- Working with pages and frames
- Loading fonts and other assets

### Limitations

- Requires manual API key configuration
- No persistent state between executions
- Basic security validation only
- Execution time limited by OpenRouter API response time

## Security Considerations

The plugin includes basic security measures:

- Validates generated code contains expected function structure
- Blocks common unsafe operations (fetch, XMLHttpRequest, etc.)
- Uses typed error handling
- Runs in Figma's sandboxed environment

**Note**: This is an MVP implementation. Production use would require more robust security measures.

## Development

### Project Structure

```
src/
├── main.ts          # Main plugin logic
└── system_prompt.md # AI system prompt template

package.json         # Plugin manifest and dependencies
PRD.md              # Product Requirements Document
```

### Building and Testing

```bash
# Development mode
pnpm dev

# Build for production
pnpm build

# Preview built plugin
pnpm preview
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly in Figma
5. Submit a pull request

## License

This project is open source. Please check the license file for details.

## Support

For issues or questions:

1. Check the console logs in Figma for detailed error information
2. Verify your OpenRouter API key is valid and has sufficient credits
3. Ensure your prompts are clear and specific
4. Report bugs with example prompts and error messages
