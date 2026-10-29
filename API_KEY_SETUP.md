# API Key Setup Guide

## Getting Your OpenRouter API Key

1. Visit [OpenRouter.ai](https://openrouter.ai/)
2. Sign up for an account or sign in
3. Go to your [API Keys page](https://openrouter.ai/keys)
4. Click "Create Key"
5. Give your key a name (e.g., "FigPal Plugin")
6. Copy the generated API key

## Adding the API Key to FigPal

1. Create a `.env` file in the root of the project (if it doesn't exist)
2. Add your OpenRouter API key and preferred model to the `.env` file:

   ```env
   OPENROUTER_API_KEY=sk-or-v1-your-actual-key-here
   MODEL=openai/gpt-4o
   ```

   **Available Models:**

   - `openai/gpt-4o` (recommended, most capable)
   - `openai/gpt-4o-mini` (faster, cheaper)
   - `anthropic/claude-3.5-sonnet` (alternative, good for code)
   - `moonshotai/kimi-k2:free` (free option, limited capabilities)

3. Save the file
4. Rebuild the plugin:
   ```bash
   pnpm build
   ```

The plugin will automatically load these environment variables from the `.env` file.

## Important Security Notes

- **Never commit your API key to version control**
- **Keep your API key private and secure**
- **For production use, implement proper secret management**

## Testing Your Setup

1. Import the plugin into Figma (see main README for instructions)
2. Run the plugin with a simple prompt like "Create a red rectangle"
3. If you see a message about API key configuration, check that your `.env` file exists and has the correct variables

## Troubleshooting

- **"API key not configured"**: Make sure your `.env` file exists and contains the correct `OPENROUTER_API_KEY`
- **"Network error"**: Check that your API key is valid and you have credits
- **"Generation failed"**: Verify your OpenRouter account has sufficient credits
- **Plugin doesn't load .env**: Ensure the `.env` file is in the project root directory
