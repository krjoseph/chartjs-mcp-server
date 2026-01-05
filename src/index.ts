#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateChart } from './chart-generator.js';

// Parse command line arguments
const args = process.argv.slice(2);
const transportArg = args.find(arg => arg.startsWith('--transport='));
const portArg = args.find(arg => arg.startsWith('--port='));

const transport = transportArg?.split('=')[1] || 'stdio';
const port = parseInt(process.env.PORT || portArg?.split('=')[1] || '3000', 10);

// Create MCP server instance
const server = new McpServer(
  {
    name: "@ax-crew/chartjs-mcp-server",
    version: "3.1.12",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Validation function for chart configuration
function validateChartConfig(chartConfig: any) {
  // Handle case where chartConfig is a string (parse it)
  let config = chartConfig;
  if (typeof chartConfig === 'string') {
    try {
      config = JSON.parse(chartConfig);
    } catch (parseError) {
      throw new Error('Chart configuration string is not valid JSON');
    }
  }

  // Check if config is an object
  if (!config || typeof config !== 'object') {
    throw new Error('Chart configuration must be an object');
  }

  // Check for valid chart type
  const validTypes = ['bar', 'line', 'scatter', 'bubble', 'pie', 'doughnut', 'polarArea', 'radar'];
  if (!config.type || !validTypes.includes(config.type)) {
    throw new Error(`Invalid chart type. Must be one of: ${validTypes.join(', ')}`);
  }

  // Check for data object
  if (!config.data || typeof config.data !== 'object') {
    throw new Error('Chart configuration must include a data object');
  }

  // Check for datasets array
  if (!config.data.datasets || !Array.isArray(config.data.datasets)) {
    throw new Error('Chart data must include a datasets array');
  }

  // Check for at least one dataset
  if (config.data.datasets.length === 0) {
    throw new Error('Chart data must include at least one dataset');
  }

  return config; // Return the parsed config
}

// Register the chart generation tool
server.registerTool(
  "generateChart",
  {
    title: "Generate Chart",
    description: "Generates charts using Chart.js. Can output PNG images or interactive HTML divs. Supports full Chart.js v4 configuration options.",
    inputSchema: {
      chartConfig: z.any().describe("Complete Chart.js configuration object supporting full v4 schema"),
      outputFormat: z.enum(['png', 'html']).optional().default('png').describe("Output format: 'png' for static image, 'html' for interactive HTML div"),
      saveToFile: z.boolean().optional().default(false).describe("Whether to save PNG to file (only applies to PNG format)")
    }
  },
  async ({ chartConfig, outputFormat, saveToFile }) => {
    // Validate chart configuration first and get parsed config
    let parsedChartConfig;
    try {
      parsedChartConfig = validateChartConfig(chartConfig);
    } catch (validationError) {
      // Return validation error as content
      const message = validationError instanceof Error ? validationError.message : String(validationError);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${message}`
          }
        ]
      };
    }

    const result = await generateChart(parsedChartConfig, outputFormat, saveToFile);

    if (result.success) {
      // Handle HTML format
      if (result.htmlSnippet) {
        return {
          content: [
            {
              type: "text",
              text: result.htmlSnippet,
              mimeType: "text/html",
              _meta: {
                mimeType: "text/html",
              }
            }
          ]
        };
      }

      // Handle PNG format
      if (result.buffer) {
        // Return base64 image data
        return {
          content: [
            { 
              type: "image", 
              data: result.buffer.toString('base64'), 
              mimeType: "image/png" 
            }
          ]
        };
      } else if (result.pngFilePath) {
        // Return file path
        return {
          content: [
            {
              type: 'text',
              text: result.pngFilePath
            }
          ]
        };
      } else {
        // Fallback - shouldn't happen
        return {
          content: [
            { type: "text", text: result.message, }
          ]
        };
      }
    } else {
      return {
        content: [
          {
            type: "text", 
            text: `${result.message}\n\nPlease ensure your configuration follows the Chart.js v4 schema. Common issues:\n- Check data format matches chart type (e.g., scatter charts need {x, y} objects)\n- Verify all required dataset properties are provided\n- Ensure chart type is supported: ${['bar', 'line', 'scatter', 'bubble', 'pie', 'doughnut', 'polarArea', 'radar'].join(', ')}` 
          }
        ]
      };
    }
  }
);

// Main function to start the server
async function main() {
  if (transport === 'streamable-http') {
    await startHttpServer();
  } else {
    // Default to stdio transport
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
  }
}

// Start HTTP server for streamable-http transport
async function startHttpServer() {
  // Store transports by session ID for session management
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    
    // Handle MCP endpoint
    if (url.pathname === '/mcp') {
      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let httpTransport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        // Reuse existing transport for this session
        httpTransport = transports.get(sessionId)!;
      } else if (!sessionId && req.method === 'POST') {
        // New initialization request - create new transport
        httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            // Store the transport by session ID for future requests
            transports.set(newSessionId, httpTransport);
          }
        });

        // Clean up transport when closed
        httpTransport.onclose = () => {
          if (httpTransport.sessionId) {
            transports.delete(httpTransport.sessionId);
          }
        };

        // Connect the server to this transport
        await server.connect(httpTransport);
      } else {
        // Invalid request - no session ID for non-initialization request
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session. Send an initialization request first.'
          },
          id: null
        }));
        return;
      }

      // Handle the request
      await httpTransport.handleRequest(req, res);
      return;
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'streamable-http' }));
      return;
    }

    // 404 for all other paths
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  httpServer.listen(port, () => {
    console.log(`ChartJS MCP Server running with streamable-http transport on http://localhost:${port}/mcp`);
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    for (const transport of transports.values()) {
      await transport.close();
    }
    httpServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});